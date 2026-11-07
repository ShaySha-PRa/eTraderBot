import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, ThreadMessage } from "@rakazo/contracts";
import { createDb } from "../../../packages/db/src/index";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

const READ = "mcp__readonly-example__read_synthetic_load";

async function measureNarrow(page: Page, testInfo: TestInfo) {
  await page.setViewportSize({ width: 390, height: 844 });
  const measured = await page.evaluate(() => ({
    innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    devicePixelRatio,
  }));
  await testInfo.attach("narrow-viewport", {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
  console.log(`narrow viewport: ${JSON.stringify(measured)}`);
  expect(measured.innerWidth).toBe(390);
  expect(measured.clientWidth).toBe(390);
  expect(measured.scrollWidth).toBeLessThanOrEqual(390);
}

test("tool cards say only that tools were active; each run's record gives the real outcomes, in English and Chinese at phone width", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("rakazo.showToolActivity") == null)
      localStorage.setItem("rakazo.showToolActivity", "on");
  });
  const stamp = Date.now();
  await signup(page, `tool-header-${stamp}@rakazo.test`, "password12", "Tool Header");
  await completeOnboarding(page);
  const business = await createBusinessScope(page, "Synthetic header A");
  const supervisor = (await rpc<Bot[]>(page, "bots/list", {})).find((b) => b.businessSupervisor)!;
  await page.goto(`/app/${supervisor.id}`);

  // Three real runs, each with a real tool step in its message.
  const runIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder(/Message/).fill("turn on finish notifications");
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => {
          const snapshot = await rpc<{
            messages: ThreadMessage[];
            run?: { status: string } | null;
          }>(page, "threads/get", { botId: supervisor.id });
          const ids = [
            ...new Set(
              snapshot.messages
                .filter((m) => m.runId && m.blocks.some((b) => b.kind === "steps"))
                .map((m) => m.runId!),
            ),
          ];
          return ids.length > i && snapshot.run?.status !== "running" ? ids : null;
        },
        { timeout: 60_000 },
      )
      .not.toBeNull();
  }
  const snapshot = await rpc<{ messages: ThreadMessage[] }>(page, "threads/get", {
    botId: supervisor.id,
  });
  for (const m of snapshot.messages)
    if (m.runId && m.blocks.some((b) => b.kind === "steps") && !runIds.includes(m.runId))
      runIds.push(m.runId);
  expect(runIds).toHaveLength(3);

  // Shape the three records as Desktop reported them. These rows are constructed test data on
  // real runs: two reads (one done, one failed), a single failed read, and no recorded calls.
  const { prisma: db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const failure = {
      kind: "readonly_source",
      schemaVersion: 1,
      outcome: "error",
      workspaceId: business.spaceId,
      errorCode: "SOURCE_NO_DATA",
      retryable: false,
    };
    const success = {
      kind: "readonly_source",
      schemaVersion: 1,
      outcome: "success",
      source: {
        kind: "synthetic",
        sourceId: "synthetic-load-example",
        workspaceId: business.spaceId,
        version: "synthetic-load-v1",
        generatedAt: "2026-11-07T16:00:00+08:00",
        timezone: "Asia/Shanghai",
      },
      date: "2026-11-08",
      candidateOnly: true,
      periods: [
        { start: "2026-11-08T00:00:00+08:00", end: "2026-11-08T01:00:00+08:00", forecastMWh: 12.5 },
      ],
    };
    const rows = async (runId: string, calls: [string, string, object | null][]) => {
      const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
      const attempt = await db.attempt.findFirstOrThrow({ where: { runId } });
      // Only the read-only calls are shown; the real settings call is removed from the record.
      await db.runToolCall.deleteMany({ where: { runId } });
      if (calls.length)
        await db.runToolCall.createMany({
          data: calls.map(([executionId, status, resultSummary], index) => ({
            spaceId: run.spaceId,
            userId: run.userId,
            runId,
            attemptId: attempt.id,
            executionId,
            name: READ,
            status,
            startedAt: new Date(attempt.startedAt.getTime() + 100 * (index + 1)),
            finishedAt: new Date(attempt.startedAt.getTime() + 100 * (index + 1) + 50),
            ...(resultSummary ? { resultSummary } : {}),
          })),
        });
    };
    await rows(runIds[0]!, [
      ["read-1", "completed", success],
      ["read-2", "failed", failure],
    ]);
    await rows(runIds[1]!, [["read-1", "failed", failure]]);
    await rows(runIds[2]!, []);
  } finally {
    await pool.end();
  }

  await measureNarrow(page, testInfo);
  for (const [language, w] of [
    [
      "English",
      { header: "Tool activity", done: "Done", failed: "Failed", none: "No tool calls recorded" },
    ],
    ["中文", { header: "工具活动", done: "完成", failed: "失败", none: "未记录工具调用" }],
  ] as const) {
    await page
      .getByTestId("language-switcher")
      .getByRole("button", { name: language, exact: true })
      .click();
    await page.reload();
    const cards = page.getByTestId("tool-activity");
    await expect(cards).toHaveCount(3);
    const toggles = cards.locator("button[aria-expanded]");
    for (let i = 0; i < 3; i++) {
      // The folded label neither counts steps as tools nor reads as a result.
      const label = (await toggles.nth(i).textContent()) ?? "";
      expect(label).toContain(w.header);
      expect(label).not.toMatch(/\d+\s*(tools?|个工具)|Done|完成/);
    }
    const record = async (i: number): Promise<Locator> => {
      await toggles.nth(i).click();
      const calls = cards.nth(i).getByTestId("run-tool-calls");
      await expect(calls).toBeVisible();
      return calls;
    };
    const both = await record(0);
    const reads = both.getByRole("listitem").filter({ hasText: "read_synthetic_load" });
    await expect(reads).toHaveCount(2);
    await expect(reads.nth(0)).toContainText(w.done);
    await expect(reads.nth(1)).toContainText(w.failed);
    const single = await record(1);
    const one = single.getByRole("listitem").filter({ hasText: "read_synthetic_load" });
    await expect(one).toHaveCount(1);
    await expect(one).toContainText(w.failed);
    await expect(one).not.toContainText(w.done);
    const none = await record(2);
    await expect(none).toContainText(w.none);
    await expect(none.getByRole("listitem")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await cards.first().scrollIntoViewIfNeeded();
    await captureScreenshot(
      page,
      testInfo,
      `tool-activity-header-narrow-${language === "中文" ? "zh" : "en"}`,
    );
  }
});

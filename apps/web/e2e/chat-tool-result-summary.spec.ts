import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, ThreadMessage } from "@rakazo/contracts";
import { createDb } from "../../../packages/db/src/index";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

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

test("a chat's tool card shows each recorded call's outcome and safe source summary, and never another business's", async ({
  page,
}, testInfo) => {
  // Tool activity is the person's own display choice; this journey has it turned on.
  await page.addInitScript(() => {
    if (localStorage.getItem("rakazo.showToolActivity") == null)
      localStorage.setItem("rakazo.showToolActivity", "on");
  });
  const stamp = Date.now();
  const email = `tool-summary-${stamp}@rakazo.test`;
  await signup(page, email, "password12", "Tool Summary");
  await completeOnboarding(page);
  const home = await rpc<{ spaceId: string }>(page, "me", {});
  const business = await createBusinessScope(page, "Synthetic summary A");
  const supervisor = (await rpc<Bot[]>(page, "bots/list", {})).find((b) => b.businessSupervisor)!;
  await page.goto(`/app/${supervisor.id}`);

  // A real run with a real tool call; its message carries the run id.
  await page.getByPlaceholder(/Message/).fill("turn on finish notifications");
  await page.keyboard.press("Enter");
  let runId = "";
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ messages: ThreadMessage[]; run?: { status: string } | null }>(
          page,
          "threads/get",
          { botId: supervisor.id },
        );
        const withSteps = snapshot.messages.find(
          (m) => m.runId && m.blocks.some((b) => b.kind === "steps"),
        );
        runId = withSteps?.runId ?? "";
        return Boolean(runId) && snapshot.run?.status !== "running";
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // Persist three read-only source calls on that run, shaped as the backend records them: a
  // failed read, a successful retry, and a refused call. These rows are constructed test data.
  const { prisma: db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    const attempt = await db.attempt.findFirstOrThrow({ where: { runId } });
    const at = (offset: number) => new Date(attempt.startedAt.getTime() + offset);
    const base = {
      spaceId: run.spaceId,
      userId: run.userId,
      runId,
      attemptId: attempt.id,
      name: "mcp__readonly-example__read_synthetic_load",
    };
    await db.runToolCall.createMany({
      data: [
        {
          ...base,
          executionId: "read-1",
          status: "failed",
          startedAt: at(100),
          finishedAt: at(150),
          resultSummary: {
            kind: "readonly_source",
            schemaVersion: 1,
            outcome: "error",
            workspaceId: business.spaceId,
            errorCode: "SOURCE_UNREACHABLE",
            retryable: true,
          },
        },
        {
          ...base,
          executionId: "read-2",
          status: "completed",
          startedAt: at(200),
          finishedAt: at(260),
          resultSummary: {
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
              {
                start: "2026-11-08T00:00:00+08:00",
                end: "2026-11-08T01:00:00+08:00",
                forecastMWh: 12.5,
              },
              {
                start: "2026-11-08T01:00:00+08:00",
                end: "2026-11-08T02:00:00+08:00",
                forecastMWh: 13.5,
              },
            ],
          },
        },
        {
          ...base,
          executionId: "read-3",
          status: "refused",
          startedAt: at(300),
          finishedAt: at(302),
        },
      ],
    });

    const openRecord = async () => {
      const card = page.getByTestId("tool-activity").last();
      await card.locator("button[aria-expanded]").first().click();
      const record = card.getByTestId("run-tool-calls");
      await expect(record).toBeVisible();
      return record;
    };
    await page.reload();
    let record = await openRecord();
    const reads = record.getByRole("listitem").filter({ hasText: "read_synthetic_load" });
    await expect(reads).toHaveCount(3);
    await expect(reads.nth(0)).toContainText("Failed");
    await expect(reads.nth(1)).toContainText("Done");
    await expect(reads.nth(2)).toContainText("Refused");
    await expect(reads.nth(2).getByTestId("tool-result-summary")).toHaveCount(0);
    await reads.nth(0).getByText("Error details", { exact: true }).click();
    await expect(reads.nth(0)).toContainText("The source could not be reached");
    await reads.nth(1).getByText("Source details", { exact: true }).click();
    for (const text of [
      "Synthetic · synthetic-load-example",
      business.spaceId,
      "synthetic-load-v1",
      "2026-11-08",
      "00:00–01:00 · 12.5 MWh",
      "01:00–02:00 · 13.5 MWh",
      "Candidate data only, not recorded as business evidence",
    ])
      await expect(reads.nth(1)).toContainText(text);
    await captureScreenshot(page, testInfo, "tool-summary-en");

    // Chinese at phone width, read again from the page.
    await page
      .getByTestId("language-switcher")
      .getByRole("button", { name: "中文", exact: true })
      .click();
    await measureNarrow(page, testInfo);
    await page.reload();
    record = await openRecord();
    const zhReads = record.getByRole("listitem").filter({ hasText: "read_synthetic_load" });
    await expect(zhReads.nth(0)).toContainText("失败");
    await expect(zhReads.nth(2)).toContainText("已拒绝");
    await zhReads.nth(0).getByText("错误详情", { exact: true }).click();
    await expect(zhReads.nth(0)).toContainText("无法连接数据源");
    await zhReads.nth(1).getByText("来源详情", { exact: true }).click();
    await expect(zhReads.nth(1)).toContainText("仅为候选资料，未记录为业务证据");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await zhReads.nth(1).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "tool-summary-narrow-zh");

    // Another business neither shows the summary nor can read the run.
    await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.spaceId);
    await page.goto("/app");
    await expect(page.getByText("synthetic-load-example")).toHaveCount(0);
    const crossBusiness = await page.request.post("/rpc/runs/detail", {
      data: { json: { runId } },
      headers: { "x-rakazo-space-id": home.spaceId },
    });
    expect(crossBusiness.status()).toBe(404);

    // Back in business A it is readable again; then access is removed for real.
    await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), business.spaceId);
    await page.goto(`/app/${supervisor.id}`);
    record = await openRecord();
    await expect(
      record.getByRole("listitem").filter({ hasText: "read_synthetic_load" }),
    ).toHaveCount(3);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await db.spaceMember.delete({
      where: { spaceId_userId: { spaceId: business.spaceId, userId: user.id } },
    });
    await page.reload();
    await expect(page.getByText("你已无权访问之前的业务", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("synthetic-load-example")).toHaveCount(0);
    await expect(page.getByTestId("run-tool-calls")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "tool-summary-revoked-narrow-zh");
  } finally {
    await pool.end();
  }
});

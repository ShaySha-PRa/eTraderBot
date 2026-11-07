import { expect, test } from "@playwright/test";
import type { Bot, RunTraceRow } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

test("a ticket lists the runs it started, opens their detail and survives refresh, errors and Chinese at phone width", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const title = "Check contract coverage";
  await signup(page, `board-runs-${stamp}@rakazo.test`, "password12", "Board Runs");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");

  await page.goto("/app/board");
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const created = page.getByRole("dialog", { name: "New ticket" });
  await created.getByLabel("Title").fill(title);
  await created.getByLabel("Owner").selectOption({ label: "Planner" });
  await created.getByRole("button", { name: "Create", exact: true }).click();
  await expect(created).toBeHidden();

  // Creating the ticket wakes its owner; that run is linked to the ticket and listed with it.
  const card = page.locator("[data-testid^='board-card-']").filter({ hasText: title });
  await card.click();
  const dialog = page.getByRole("dialog", { name: title });
  const runs = dialog.getByTestId("ticket-runs");
  const run = runs.getByRole("button", { name: /Planner/ });
  await expect(run).toHaveCount(1, { timeout: 30_000 });
  await expect(run).toContainText("Done", { timeout: 60_000 });
  await expect(run.locator("time")).toHaveText(/GMT\+8/);

  await run.click();
  const detail = runs.getByTestId("run-detail");
  await expect(detail).toContainText("RAK-1 · To do");
  await expect(detail).toContainText("Done");
  await expect(detail.getByRole("link", { name: "Planner" })).toHaveAttribute(
    "href",
    /^\/app\/[^/]+$/,
  );
  await expect(detail).toContainText(/Cost/);
  await expect(detail).toContainText(/Tools/);
  await captureScreenshot(page, testInfo, "board-run-detail-en");

  // The link is persisted: a fresh page load lists the same run.
  await page.reload({ waitUntil: "domcontentloaded" });
  await card.click();
  await expect(run).toHaveCount(1, { timeout: 15_000 });

  // The rest happens in Chinese on a phone-width screen.
  await page.keyboard.press("Escape");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
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

  // A failed list load says so in Chinese and recovers with Try again.
  let failures = 0;
  await page.route("**/rpc/runs/forTicket", async (route) => {
    failures += 1;
    await route.fulfill({
      status: 500,
      json: {
        json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "boom" },
      },
    });
  });
  await card.click();
  const zhDialog = page.getByRole("dialog", { name: title });
  const zhRuns = zhDialog.getByTestId("ticket-runs");
  await expect(zhRuns.getByRole("alert")).toHaveText("无法加载运行记录");
  await expect(zhRuns).not.toContainText("boom");
  expect(failures).toBeGreaterThan(0);
  await zhRuns.getByRole("alert").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "board-runs-error-narrow-zh");
  await page.unroute("**/rpc/runs/forTicket");
  await zhRuns.getByRole("button", { name: "重试", exact: true }).click();
  const zhRun = zhRuns.getByRole("button", { name: /Planner/ });
  await expect(zhRun).toHaveCount(1);
  await expect(zhRun).toContainText("完成");
  await expect(zhRuns.getByRole("alert")).toHaveCount(0);
  await zhRun.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "board-runs-narrow-zh");

  await zhRun.click();
  const zhDetail = zhRuns.getByTestId("run-detail");
  await expect(zhDetail).toContainText("RAK-1 · 待办");
  await expect(zhDetail.getByRole("button", { name: "全部运行" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await zhDetail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await zhDetail.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "board-run-detail-narrow-zh");
  await zhDetail.getByRole("button", { name: "全部运行" }).click();
  await expect(zhRun).toBeVisible();
});

test("runs by the same Bot started close together stay distinguishable in English and Chinese at phone width", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const title = "Reassigned contract check";
  await signup(page, `board-same-bot-${stamp}@rakazo.test`, "password12", "Same Bot Runs");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");
  await createNamedBot(page, "Reviewer");
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const planner = bots.find((bot) => bot.name === "Planner")!;
  const reviewer = bots.find((bot) => bot.name === "Reviewer")!;

  await page.goto("/app/board");
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const created = page.getByRole("dialog", { name: "New ticket" });
  await created.getByLabel("Title").fill(title);
  await created.getByLabel("Owner").selectOption({ label: "Planner" });
  await created.getByRole("button", { name: "Create", exact: true }).click();
  await expect(created).toBeHidden();
  const card = page.locator("[data-testid^='board-card-']").filter({ hasText: title });
  const ticketId = (await card.getAttribute("data-testid"))!.replace("board-card-", "");
  // Planner → Reviewer → Planner in quick succession, as in the reported case.
  await rpc(page, "tickets/update", { id: ticketId, assigneeBotId: reviewer.id });
  await rpc(page, "tickets/update", { id: ticketId, assigneeBotId: planner.id });

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

  const { runs } = await rpc<{ runs: RunTraceRow[] }>(page, "runs/forTicket", { ticketId });
  const plannerRuns = runs.filter((run) => run.botId === planner.id);
  expect(plannerRuns).toHaveLength(2);
  const codes = plannerRuns.map((run) => run.runId.slice(-8));
  expect(codes[0]).not.toBe(codes[1]);

  for (const [language, runWord, allRuns] of [
    ["English", "Run", "All runs"],
    ["中文", "运行", "全部运行"],
  ] as const) {
    await page
      .getByTestId("language-switcher")
      .getByRole("button", { name: language, exact: true })
      .click();
    await card.click();
    const section = page.getByRole("dialog", { name: title }).getByTestId("ticket-runs");
    const rows = codes.map((code) =>
      section.getByRole("button", { name: new RegExp(`^${runWord} ${code}[,，] ?Planner`) }),
    );
    for (const [index, row] of rows.entries()) {
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row).toContainText(`#${codes[index]}`);
    }
    await rows[0]!.scrollIntoViewIfNeeded();
    await captureScreenshot(
      page,
      testInfo,
      `board-same-bot-runs-narrow-${language === "中文" ? "zh" : "en"}`,
    );

    for (const [index, row] of rows.entries()) {
      await row.click();
      const detail = section.getByRole("region", { name: `${runWord} ${codes[index]}` });
      await expect(detail).toContainText(plannerRuns[index]!.runId);
      await expect(detail).not.toContainText(plannerRuns[1 - index]!.runId);
      expect(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await detail.scrollIntoViewIfNeeded();
      await captureScreenshot(
        page,
        testInfo,
        `board-same-bot-detail-${index + 1}-narrow-${language === "中文" ? "zh" : "en"}`,
      );
      await detail.getByRole("button", { name: allRuns }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.keyboard.press("Escape");
  }
});

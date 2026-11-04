import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { TradingAnalysis } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewBot, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

// A host clock rollback must refuse a future snapshot. Wait for its original observation
// time before retrying that refused UI action; never rewrite data or ignore other failures.
async function currentSourceAction(page: Page, procedure: string, click: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const waiting = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/rpc/trading/${procedure}`,
    );
    await click();
    const response = await waiting;
    const body: { json?: { data?: { reason?: string } } } = await response.json();
    if (response.status() !== 400 || body.json?.data?.reason !== "STALE_DATA") return response;
    const analyses = await rpc<TradingAnalysis[]>(page, "trading/history", { limit: 1 });
    const snapshot = analyses[0]!.snapshot;
    expect(Date.now()).toBeLessThan(
      Math.min(
        Date.parse(snapshot.source.validUntil),
        Date.parse(snapshot.rules.source.validUntil),
      ),
    );
    expect(Date.now() - Date.parse(snapshot.source.asOf)).toBeLessThan(
      snapshot.rules.maxSnapshotAgeSeconds * 1000,
    );
    await expect
      .poll(() => Date.now(), { timeout: 15000 })
      .toBeGreaterThanOrEqual(
        Math.max(
          Date.parse(snapshot.source.observedAt),
          Date.parse(snapshot.rules.source.observedAt),
        ),
      );
  }
  throw new Error("The service clock did not stabilize for the original snapshot");
}

test("trading reviews and executes a candidate with independent approval and bounded authorization", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `trading-${Date.now()}@rakazo.test`, "password12", "Trading QA");
  await completeOnboarding(page);
  await createBusinessScope(page);
  await openNewBot(page);
  const create = page.getByTestId("create-bot-dialog");
  await create.getByRole("radio", { name: /Spot bot/ }).check();
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(page).toHaveURL(/workspace=trading/);
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await currentSourceAction(page, "prepareIntent", () =>
    page.getByRole("button", { name: "Prepare intent", exact: true }).click(),
  );
  const first = page.getByTestId("trading-intent");
  await expect(
    first.getByRole("button", { name: "Execute simulation", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Approve algorithm", exact: true }).click();
  await expect(
    first.getByRole("button", { name: "Execute simulation", exact: true }),
  ).toBeDisabled();
  await currentSourceAction(page, "approveIntent", () =>
    first.getByRole("button", { name: "Approve trade", exact: true }).click(),
  );
  await currentSourceAction(page, "executeSimulation", () =>
    first.getByRole("button", { name: "Execute simulation", exact: true }).click(),
  );
  await expect(page.getByTestId("trading-receipt")).toContainText("Synthetic fill");
  await captureScreenshot(page, testInfo, "trading-approved-simulation");
  await page.getByText("New authorization", { exact: true }).click();
  const grant = page.getByRole("form", { name: "New authorization", exact: true });
  await grant.getByLabel("Single intent limit (CNY)").fill("4999");
  await grant.getByRole("button", { name: "Create authorization", exact: true }).click();
  await expect(page.getByText("0 / 10000 CNY", { exact: false }).first()).toBeVisible();
  await currentSourceAction(page, "prepareIntent", () =>
    page.getByRole("button", { name: "Prepare intent", exact: true }).click(),
  );
  const next = page
    .getByTestId("trading-intent")
    .filter({ has: page.getByRole("button", { name: "Execute simulation", exact: true }) });
  await next.getByLabel("Authorization", { exact: true }).selectOption({ index: 1 });
  await currentSourceAction(page, "executeSimulation", () =>
    next.getByRole("button", { name: "Execute simulation", exact: true }).click(),
  );
  await expect(next.getByRole("alert")).toContainText("Single trade limit exceeded");
  await expect(next.getByLabel("Authorization", { exact: true })).toBeEnabled();
  await grant.getByLabel("Single intent limit (CNY)").fill("5000");
  await grant.getByRole("button", { name: "Create authorization", exact: true }).click();
  await page.getByText("Simulation scenario", { exact: true }).click();
  await page.getByLabel("New orders", { exact: true }).selectOption("cancel_timeout");
  await expect(page.getByLabel("New orders", { exact: true })).toBeEnabled();
  const allowed = await next
    .getByLabel("Authorization", { exact: true })
    .locator("option")
    .filter({ hasText: "≤ 5000 CNY" })
    .getAttribute("value");
  await next.getByLabel("Authorization", { exact: true }).selectOption(allowed!);
  await currentSourceAction(page, "executeSimulation", () =>
    next.getByRole("button", { name: "Execute simulation", exact: true }).click(),
  );
  await expect(page.getByTestId("trading-receipt")).toHaveCount(2);
  const partialOrder = page
    .getByTestId("trading-intent")
    .filter({ has: page.getByRole("button", { name: "Cancel order", exact: true }) });
  await expect(partialOrder.getByTestId("trading-receipt")).toContainText("Partially filled");
  await partialOrder.getByRole("button", { name: "Cancel order", exact: true }).click();
  await expect(partialOrder.getByTestId("trading-receipt")).toContainText(
    "Result uncertain; the reservation is retained.",
  );
  await captureScreenshot(page, testInfo, "trading-cancellation-timeout");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "核对订单", exact: true })).toBeVisible();
  await expect(page.getByText("结果尚未确认，占用额度继续保留。", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "trading-cancellation-timeout-zh");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "English", exact: true })
    .click();
  await partialOrder.getByRole("button", { name: "Reconcile order", exact: true }).click();
  await expect(page.getByTestId("trading-receipt").filter({ hasText: "Cancelled" })).toBeVisible();
  await expect(page.getByText(/2500 \/ 10000 CNY · Reserved 0 CNY/)).toBeVisible();
  await captureScreenshot(page, testInfo, "trading-cancelled-settled");
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await expect(page.getByText("Revoked", { exact: false }).first()).toBeVisible();
  await page
    .getByRole("navigation", { name: "Bot workspace" })
    .getByRole("button", { name: "Learning", exact: true })
    .click();
  const learning = page.getByRole("region", { name: "Learning", exact: true });
  await expect(learning.getByText("02:00 · Asia/Shanghai · Daily")).toBeVisible();
  await learning.getByText("Edit learning plan", { exact: true }).click();
  await learning.getByLabel("Daily time", { exact: true }).fill("03:15");
  await learning.getByLabel("Time zone", { exact: true }).fill("Asia/Taipei");
  await learning.getByLabel("Learning schedule", { exact: true }).selectOption("false");
  await learning.getByRole("button", { name: "Save plan", exact: true }).click();
  await expect(learning.getByText("03:15 · Asia/Taipei · Paused")).toBeVisible();
  await learning.getByText("Add learning material", { exact: true }).click();
  await learning.getByLabel("Source reference", { exact: true }).fill("synthetic-trader-feedback");
  await learning
    .getByLabel("Trader feedback", { exact: true })
    .fill(
      "Synthetic learning observation; compare a conservative margin under the same physical constraints.",
    );
  await learning.getByRole("button", { name: "Save material", exact: true }).click();
  await expect(learning.getByLabel("Upload learning file", { exact: true })).toBeEnabled();
  await learning.getByLabel("Upload learning file", { exact: true }).setInputFiles({
    name: "synthetic-learning.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("period,note\n1,synthetic\n"),
  });
  await expect(learning.getByText(/Authorized materials/)).toBeVisible();
  await learning.getByText(/Authorized materials/).click();
  await expect(
    learning.getByText("File · user:synthetic-learning.csv", { exact: true }),
  ).toBeVisible();
  await learning.getByRole("button", { name: "Learn now", exact: true }).click();
  await expect(learning.getByText("Learning runs", { exact: true })).toBeVisible();
  await learning.getByText("Learning runs", { exact: true }).click();
  await learning.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "trading-learning");
  await captureScreenshot(page, testInfo, "trading-bounded-authorization");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await captureScreenshot(page, testInfo, "trading-mobile-web");
  await page.reload();
  await expect(learning.getByText("03:15 · Asia/Taipei · Paused")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Bot workspace" })
    .getByRole("button", { name: "Trading", exact: true })
    .click();
  await expect(page.getByTestId("trading-receipt")).toHaveCount(2);
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "模拟交易", exact: true })).toBeVisible();
  await expect(page.getByTestId("trading-receipt")).toHaveCount(2);
  await expect(page.getByTestId("trading-intent").first()).toContainText("GMT+8");
  await captureScreenshot(page, testInfo, "trading-workspace-zh");
  await page
    .getByRole("navigation", { name: "Bot 工作区" })
    .getByRole("button", { name: "学习", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "学习", exact: true })
      .getByText("03:15 · Asia/Taipei · 已暂停"),
  ).toBeVisible();
  await page.getByRole("region", { name: "学习", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "trading-learning-zh");
});

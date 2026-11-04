import { expect, test } from "@playwright/test";
import type {
  Bot,
  TradingBotRole,
  TradingDesk,
  TradingInterface,
  TradingWorkspace,
} from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewBot, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("four Bot templates keep trading and learning in their own workspace", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `templates-${Date.now()}@rakazo.test`, "password12", "Template QA");
  await completeOnboarding(page);
  const scope = await createBusinessScope(page);
  const createdIds: string[] = [];
  for (const [role, name, tab] of [
    ["spot", "Spot bot", "Trading"],
    ["mid_long_term", "Mid / long term bot", "Trading"],
    ["risk", "Risk bot", "Risk review"],
    ["review", "Review bot", "Trading review"],
  ] as const) {
    await openNewBot(page);
    const dialog = page.getByTestId("create-bot-dialog");
    await dialog.getByRole("radio", { name: new RegExp(name) }).check();
    if (role === "spot") await captureScreenshot(page, testInfo, "bot-template-picker-en");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/workspace=trading/);
    const botId = new URL(page.url()).pathname.split("/").at(-1)!;
    const bot = await rpc<Bot>(page, "bots/get", { botId });
    expect(bot.tradingRole).toBe(role satisfies TradingBotRole);
    createdIds.push(botId);
    await expect(
      page.locator(`[data-roster-bot-id="${botId}"]`).getByTestId("bot-business-labels"),
    ).toHaveText(scope.name);
    await expect(
      page.getByTestId("bot-settings-trigger").getByTestId("bot-business-labels"),
    ).toHaveText(scope.name);
    const nav = page.getByRole("navigation", { name: "Bot workspace" });
    await expect(nav.getByRole("button", { name: tab, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("heading", { name: "Candidate analysis", exact: true }),
    ).toBeVisible();
    const scopes = await rpc<TradingDesk[]>(page, "trading/desks", { botId });
    expect(scopes).toHaveLength(role === "spot" ? 3 : role === "mid_long_term" ? 1 : 4);
    await expect(page.getByRole("button", { name: "Run analysis", exact: true })).toHaveCount(
      role === "risk" || role === "review" ? 0 : 1,
    );
    await nav.getByRole("button", { name: "Learning", exact: true }).click();
    await expect(page.getByText("02:00 · Asia/Shanghai · Daily", { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Candidate analysis", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("form", { name: "New trading scope" })).toHaveCount(0);
    await page.reload();
    await expect(nav.getByRole("button", { name: "Learning", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page).not.toHaveURL(/workspace=/);
    await nav.getByRole("button", { name: tab, exact: true }).click();
    if (role === "risk") await captureScreenshot(page, testInfo, "bot-risk-workspace-en");
  }
  const grouped = (await rpc<TradingWorkspace[]>(page, "trading/workspaces", {})).find(
    (row) => row.id === scope.id,
  )!;
  expect(new Set(grouped.botIds)).toEqual(new Set(createdIds));
  expect(grouped.deskIds).toHaveLength(4);
  const sidebar = page.getByTestId("bots-sidebar");
  for (const id of createdIds)
    await expect(sidebar.locator(`[data-roster-bot-id="${id}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await page.getByRole("button", { name: "Add interface", exact: true }).click();
  const form = page.getByRole("form", { name: "Interface configuration", exact: true });
  await form.getByLabel("Name", { exact: true }).fill("Synthetic price API");
  await form.getByLabel("API URL", { exact: true }).fill("https://api.example.test/prices");
  await form.getByLabel("Authentication", { exact: true }).selectOption("header");
  await form.getByLabel("Credential field name", { exact: true }).fill("X-API-Key");
  await form.getByLabel("API credential", { exact: true }).fill("synthetic-demo-token");
  await form.getByRole("button", { name: "Save interface", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("business-interface")).toContainText("Configured · not verified");
  const entries = await rpc<TradingInterface[]>(page, "trading/interfaces", {
    workspaceId: scope.id,
  });
  expect(entries[0]!.hasSecret).toBe(true);
  expect(JSON.stringify(entries)).not.toContain("synthetic-demo-token");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(form.getByLabel("API credential", { exact: true })).toHaveValue("");
  await form.getByLabel("Name", { exact: true }).fill("Synthetic market API");
  await form.getByRole("button", { name: "Save interface", exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole("button", { name: "Add interface", exact: true }).click();
  await form.getByLabel("Name", { exact: true }).fill("Synthetic forecast API");
  await form.getByLabel("Purpose", { exact: true }).selectOption("forecasts");
  await form.getByLabel("API URL", { exact: true }).fill("https://api.example.test/forecasts");
  await form.getByRole("button", { name: "Save interface", exact: true }).click();
  await expect(page.getByTestId("business-interface")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "business-interfaces-en");
  const other = await createBusinessScope(page, "Synthetic Shanghai business");
  await expect(
    page.getByText("No bots in this business scope yet.", { exact: true }),
  ).toBeVisible();
  for (const id of createdIds)
    await expect(sidebar.locator(`[data-roster-bot-id="${id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await expect(page.getByTestId("business-interface")).toHaveCount(0);
  expect(await rpc(page, "trading/interfaces", { workspaceId: other.id })).toEqual([]);
  await page.reload();
  await expect(page.getByTestId("business-interfaces")).toBeVisible();
  await page.getByRole("button", { name: "Back to bots", exact: true }).click();
  await expect(page.getByText("Add an existing bot", { exact: true })).toHaveCount(0);
  await openNewBot(page);
  const newBot = page.getByTestId("create-bot-dialog");
  await newBot.getByRole("button", { name: "Create", exact: true }).click();
  await expect(newBot).toBeHidden();
  const otherBotId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(createdIds).not.toContain(otherBotId);
  expect((await rpc<Bot>(page, "bots/get", { botId: otherBotId })).spaceId).toBe(other.spaceId);
  const picker = page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true });
  await picker.selectOption("");
  const firstLabels = sidebar
    .locator(`[data-roster-bot-id="${createdIds[0]}"]`)
    .getByTestId("bot-business-labels");
  await expect(firstLabels).toHaveText(scope.name);
  await expect(
    sidebar.locator(`[data-roster-bot-id="${otherBotId}"]`).getByTestId("bot-business-labels"),
  ).toHaveText(other.name);
  await page.reload();
  await expect(picker).toHaveValue("");
  await expect(firstLabels).toHaveText(scope.name);
  // Opening a Bot from the aggregate switches RPC/crypto context to its own business.
  await sidebar.locator(`[data-roster-bot-id="${createdIds[0]}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${createdIds[0]}`));
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(scope.spaceId);
  const headerLabels = page.getByTestId("bot-settings-trigger").getByTestId("bot-business-labels");
  await expect(headerLabels).toHaveText(scope.name);
  await captureScreenshot(page, testInfo, "bot-business-labels-en");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByTestId("business-scope-picker").getByLabel("业务范围", { exact: true }),
  ).toBeVisible();
  await expect(firstLabels).toHaveText(scope.name);
  await captureScreenshot(page, testInfo, "bot-business-labels-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(headerLabels).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-business-labels-mobile-zh");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "English", exact: true })
    .click();
  await page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true })
    .selectOption(scope.spaceId);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await expect(page.getByTestId("business-interface")).toHaveCount(2);
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "接口设置", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "business-interfaces-zh");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "English", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to bots", exact: true }).click();
  await page.goto(`/app/${createdIds.at(-1)}?workspace=trading`);
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Trading", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "交易复盘", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-review-workspace-zh");
  await openNewBot(page);
  await expect(page.getByRole("radio", { name: /中长期交易 Bot/ })).toBeVisible();
  await page.getByRole("radio", { name: /现货交易 Bot/ }).check();
  await captureScreenshot(page, testInfo, "bot-template-picker-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "bot-template-picker-mobile-zh");
});

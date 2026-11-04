import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  openUserSettings,
  signup,
} from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("Chinese and English shortcuts follow trading forms, navigation and account settings", async ({
  page,
}, testInfo) => {
  await signup(page, `ui-locale-shortcuts-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page);
  await createBusinessScope(page);
  await openNewBot(page);
  const create = page.getByTestId("create-bot-dialog");
  await create.getByRole("radio", { name: /Spot bot/ }).check();
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toBeHidden();
  const tradingUrl = page.url();
  const switcher = page.getByTestId("language-switcher");
  await expect(
    page.getByRole("heading", { name: "Simulation trading", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await page.getByRole("button", { name: "Add interface", exact: true }).click();
  await page.getByLabel("API URL", { exact: true }).fill("https://api.example.test/language-check");
  await switcher.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "接口设置", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存接口", exact: true })).toBeVisible();
  await expect(page.getByLabel("API 地址", { exact: true })).toHaveValue(
    "https://api.example.test/language-check",
  );
  await captureScreenshot(page, testInfo, "language-trading-zh");
  await switcher.getByRole("button", { name: "English", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Interface settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("API URL", { exact: true })).toHaveValue(
    "https://api.example.test/language-check",
  );
  await captureScreenshot(page, testInfo, "language-trading-en");
  await switcher.getByRole("button", { name: "中文", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "返回 Bots", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Bot 工作区" })
    .getByRole("button", { name: "聊天", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app(?:\/[^/?]+)?$/);
  await expect(switcher).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
  await expect(settings.getByTestId("ui-locale-select")).toHaveText("简体中文");
  await captureScreenshot(page, testInfo, "language-settings-zh");
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await captureScreenshot(page, testInfo, "language-settings-en");
  await page.getByRole("button", { name: "Close user settings", exact: true }).click();
  await expect(switcher.getByRole("button", { name: "English", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(tradingUrl);
  await switcher.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模拟交易", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "language-mobile-zh");
});

test("account settings language picker includes Hebrew and mirrors the UI right-to-left", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-he-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "עברית", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "日本語", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-he");

  await page.getByRole("option", { name: "עברית", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "כללי", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "חשבון", exact: true })).toBeVisible();
  await expect(settings.getByText("שפה", { exact: true })).toBeVisible();
  await expect(picker).toHaveText("עברית");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await captureScreenshot(page, testInfo, "ui-locale-settings-he");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport({ ratio: 1 });
  const box = await sidebar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
  await captureScreenshot(page, testInfo, "ui-locale-app-he");
});

test("Traditional Chinese can be selected, survives reload, and switches back to English", async ({
  page,
}, testInfo) => {
  await signup(page, `ui-locale-zh-tw-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);
  const settings = await openUserSettings(page);
  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "繁體中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "一般", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "帳號", exact: true })).toBeVisible();
  await expect(settings.getByText("語言", { exact: true })).toBeVisible();
  await expect(picker).toHaveText("繁體中文");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-tw");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.getByTestId("ui-locale-select")).toHaveText("繁體中文");
  await page.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
});

import { expect, test } from "@playwright/test";
import type { TradingInterface } from "@rakazo/contracts";
import { WEATHER_PUSH_PATH } from "@rakazo/contracts";
import { createSyntheticWeatherForecast } from "@rakazo/core";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("weather interface receives external forecasts, exposes units and switches Chinese/English", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `weather-${Date.now()}@rakazo.test`, "password12", "Weather QA");
  await completeOnboarding(page);
  const scope = await createBusinessScope(page);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await page.getByRole("button", { name: "Add interface", exact: true }).click();
  const form = page.getByRole("form", { name: "Interface configuration", exact: true });
  await form.getByLabel("Purpose", { exact: true }).selectOption("weather_forecast");
  await form.getByRole("button", { name: "Use local weather simulator", exact: true }).click();
  await expect(form.getByLabel("API URL", { exact: true })).toHaveValue(
    "http://127.0.0.1:8096/v1/weather/forecast",
  );
  await form.getByRole("button", { name: "Save interface", exact: true }).click();
  await expect(form).toBeHidden();
  const panel = page.getByTestId("weather-interface");
  await expect(panel.getByRole("button", { name: "Pull forecast", exact: true })).toBeVisible();
  await expect(panel).toContainText("No weather forecast received");
  await panel
    .locator("summary")
    .filter({ hasText: /^External push$/ })
    .click();
  await panel.getByRole("button", { name: "Create push token", exact: true }).click();
  const tokenInput = panel.getByLabel("Push token — shown once", { exact: true });
  await expect(tokenInput).toHaveValue(/[A-Za-z0-9_-]{43}/);
  const token = await tokenInput.inputValue();
  const [entry] = await rpc<TradingInterface[]>(page, "trading/interfaces", {
    workspaceId: scope.id,
  });
  expect(entry!.hasPushToken).toBe(true);
  const response = await page.request.post(WEATHER_PUSH_PATH.replace(":interfaceId", entry!.id), {
    headers: { authorization: `Bearer ${token}` },
    data: createSyntheticWeatherForecast(new Date(), scope.scope.region),
  });
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(panel).toContainText("Simulated data");
  await expect(panel).toContainText("Current forecast");
  await expect(tokenInput).toHaveCount(0);
  await panel
    .locator("summary")
    .filter({ hasText: /^Forecast details$/ })
    .click();
  await expect(
    panel.getByRole("columnheader", { name: "Temperature (°C)", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(24);
  await captureScreenshot(page, testInfo, "weather-forecast-en");
  const switcher = page.getByTestId("language-switcher");
  await switcher.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(panel.getByRole("button", { name: "拉取预测", exact: true })).toBeVisible();
  await expect(panel).toContainText("模拟数据");
  await expect(panel.getByRole("columnheader", { name: "风速（m/s）", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "weather-forecast-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "weather-forecast-narrow-zh");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await switcher.getByRole("button", { name: "English", exact: true }).click();
  await panel
    .locator("summary")
    .filter({ hasText: /^External push$/ })
    .click();
  await panel.getByRole("button", { name: "Revoke push token", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Create push token", exact: true })).toBeVisible();
  expect(
    (
      await page.request.post(WEATHER_PUSH_PATH.replace(":interfaceId", entry!.id), {
        headers: { authorization: `Bearer ${token}` },
        data: createSyntheticWeatherForecast(new Date()),
      })
    ).status(),
  ).toBe(401);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await form.getByLabel("Connection type", { exact: true }).selectOption("push");
  await expect(form.getByLabel("API URL", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Save interface", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(panel.getByRole("button", { name: "Pull forecast", exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Simulated data");
});

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, SpaceNavigation, TradingWorkspace } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  openNewSpace,
  rpc,
  signup,
} from "./helpers";
import { createBusinessScope, submitBusinessScope } from "./trading-business-helpers";

async function generalBot(page: Page, name: string) {
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByRole("radio", { name: "General bot", exact: true }).check();
  await dialog.getByPlaceholder("Name your Bot").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

test("an existing business is configured without moving or replacing its general Bots", async ({
  page,
}) => {
  await signup(page, `business-existing-${Date.now()}@rakazo.test`, "password12", "Business Owner");
  await completeOnboarding(page);
  const initial = await rpc<SpaceNavigation>(page, "spaces/list", {});
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  const picker = page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true });
  await expect(picker).toHaveValue(initial.current.id);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  const dialog = page.getByTestId("business-scope-dialog");
  await expect(dialog.getByRole("heading", { name: "Configure business scope" })).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveAttribute("readonly", "");
  await submitBusinessScope(page, "Save configuration");
  await expect(page.getByTestId("business-interfaces")).toContainText("Default business scope");
  const [configuration] = await rpc<TradingWorkspace[]>(page, "trading/workspaces", {});
  expect(configuration!.spaceId).toBe(initial.current.id);
  expect(configuration!.botIds).toContain(chief!.id);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toEqual([chief]);
  await page.reload();
  await expect(page.getByTestId("business-interfaces")).toBeVisible();
});

test("a business is created, renamed and deleted with its own Bots", async ({ page }, testInfo) => {
  await signup(page, `business-delete-${Date.now()}@rakazo.test`, "password12", "Business Owner");
  await completeOnboarding(page);
  await openNewSpace(page);
  const dialog = page.getByTestId("business-scope-dialog");
  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Typo business");
  // IME completion must not submit or dismiss a partly composed business name.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await name.dispatchEvent("keydown", { key: "Enter", ...composition });
    await name.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(dialog).toBeVisible();
  }
  await submitBusinessScope(page, "Create business scope");
  const picker = page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true });
  await expect(picker.locator("option:checked")).toHaveText("Typo business");
  const botId = await generalBot(page, "Business helper");
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Actions for Typo business" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  const spaceName = settings.getByTestId("space-settings").getByLabel("Name");
  await spaceName.fill("Temporary business");
  await spaceName.press("Enter");
  await expect(settings.getByRole("heading", { name: "Temporary business" })).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText("Temporary business");
  await expect(
    sidebar.locator(`[data-roster-bot-id="${botId}"]`).getByTestId("bot-business-labels"),
  ).toHaveText("Temporary business");
  expect((await rpc<TradingWorkspace[]>(page, "trading/workspaces", {}))[0]!.name).toBe(
    "Temporary business",
  );
  await captureScreenshot(page, testInfo, "business-settings-rename");
  await settings.getByRole("button", { name: "Delete business scope", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete Temporary business and its 1 bot?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(picker.locator("option:checked")).toHaveText("Default business scope");
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await page.reload();
  await expect(picker.getByRole("option", { name: "Temporary business", exact: true })).toHaveCount(
    0,
  );
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
});

test("an empty business stays in the app after deleting its last Bot", async ({ page }) => {
  await signup(page, `business-empty-${Date.now()}@rakazo.test`, "password12", "Business Owner");
  await completeOnboarding(page);
  const scope = await createBusinessScope(page, "Side business");
  const botId = await generalBot(page, "Side helper");
  const row = page.locator(`[data-roster-bot-id="${botId}"]`);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: /Delete Side helper/ })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(
    page.getByTestId("business-scope-picker").getByLabel("Business scope", { exact: true }),
  ).toHaveValue(scope.spaceId);
  await expect(
    page.locator("main").getByRole("button", { name: "New bot", exact: true }),
  ).toBeVisible();
});

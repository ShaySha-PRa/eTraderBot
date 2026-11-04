import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TradingWorkspace } from "@rakazo/contracts";
import { rpc } from "./helpers";

export async function createBusinessScope(page: Page, name = "Synthetic Shandong business") {
  await page
    .getByTestId("business-scope-picker")
    .getByRole("button", { name: "New business scope", exact: true })
    .click();
  const dialog = page.getByTestId("business-scope-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await submitBusinessScope(page, "Create business scope");
  const picker = page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true });
  await expect(picker.locator("option:checked")).toHaveText(name);
  const scope = (await rpc<TradingWorkspace[]>(page, "trading/workspaces", {})).find(
    (row) => row.name === name,
  )!;
  await expect(
    page.getByTestId("business-scope-picker").getByLabel("Business scope", { exact: true }),
  ).toHaveValue(scope.spaceId);
  return scope;
}

export async function submitBusinessScope(page: Page, action: string) {
  const dialog = page.getByTestId("business-scope-dialog");
  await dialog.getByRole("button", { name: action, exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm it's you", exact: true });
  const next = await Promise.race([
    confirmation.waitFor({ state: "visible" }).then(() => "confirm"),
    dialog.waitFor({ state: "hidden" }).then(() => "created"),
  ]);
  if (next === "confirm") {
    await confirmation.getByLabel("Password", { exact: true }).fill("password12");
    await confirmation.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(confirmation).toBeHidden();
  }
  await expect(dialog).toBeHidden();
}

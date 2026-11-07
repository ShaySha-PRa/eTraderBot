import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Bot, BusinessCycleState, TradingWorkspace } from "@rakazo/contracts";
import { rpc } from "./helpers";

export async function createBusinessScope(page: Page, name = "Synthetic Shandong business") {
  await page
    .getByTestId("business-scope-picker")
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByTestId("business-scope-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await submitBusinessScope(page, "Create workspace");
  const picker = page.getByTestId("business-scope-picker").getByLabel("Workspace", { exact: true });
  await expect(picker.locator("option:checked")).toHaveText(`${name} · Trading`);
  const scope = (await rpc<TradingWorkspace[]>(page, "trading/workspaces", {})).find(
    (row) => row.name === name,
  )!;
  await expect(
    page.getByTestId("business-scope-picker").getByLabel("Workspace", { exact: true }),
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

/** A business (its own space) with the four specialist Bots and its supervisor. */
export async function businessTeam(page: Page, name: string) {
  const scope: TradingWorkspace = await createBusinessScope(page, name);
  for (const role of ["mid_long_term", "spot", "risk", "review"])
    await rpc<Bot>(page, "bots/create", {
      name: `${name} ${role}`,
      tradingRole: role,
      tradingWorkspaceId: scope.id,
    });
  const supervisor = (await rpc<Bot[]>(page, "bots/list", {})).find((b) => b.businessSupervisor)!;
  return { scope, supervisor };
}

export async function openCycle(page: Page, supervisor: Bot, kinds: string[]) {
  await page.goto(`/app/${supervisor.id}?workspace=cycle`);
  const panel = page.getByTestId("business-cycle");
  await panel.getByRole("button", { name: "Load P25 simulation", exact: true }).click();
  await expect(panel.getByTestId("evidence-asset")).toBeVisible();
  for (const [label, kind] of kinds.entries()) {
    await panel.getByLabel("Requested work").selectOption(kind);
    await panel.getByRole("button", { name: "Assign necessary role", exact: true }).click();
    await expect(panel.locator("details > summary", { hasText: /· todo/ })).toHaveCount(label + 1);
  }
  const state = await rpc<BusinessCycleState>(page, "businessCycle/get", {
    cycleId: await panel.getByLabel("Business cycle", { exact: true }).inputValue(),
  });
  return { panel, state };
}

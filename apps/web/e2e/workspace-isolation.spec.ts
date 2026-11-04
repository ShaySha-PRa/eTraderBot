import { expect, test } from "@playwright/test";
import type { Bot, WorkspaceReadGrant } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewBot, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("trading and general workspaces isolate templates and explicit read grants", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `isolation-${Date.now()}@rakazo.test`, "password12", "Isolation QA");
  await completeOnboarding(page);
  const picker = page.getByTestId("business-scope-picker");
  await picker.getByRole("button", { name: "New workspace", exact: true }).click();
  const spaceDialog = page.getByTestId("business-scope-dialog");
  await spaceDialog.getByLabel("Workspace type", { exact: true }).selectOption("general");
  await expect(spaceDialog.getByLabel("Subject ID", { exact: true })).toHaveCount(0);
  await spaceDialog.getByLabel("Name", { exact: true }).fill("Synthetic research");
  await spaceDialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(spaceDialog).toBeHidden();
  await expect(
    picker.getByLabel("Workspace", { exact: true }).locator("option:checked"),
  ).toHaveText("Synthetic research · General");
  const generalSpaceId = await picker.getByLabel("Workspace", { exact: true }).inputValue();
  await expect(picker.getByRole("button", { name: "Interface settings", exact: true })).toHaveCount(
    0,
  );
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await expect(dialog.getByRole("radio", { name: "General bot", exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await dialog.getByLabel("Name", { exact: true }).fill("Synthetic reader");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  const reader = (await rpc<Bot[]>(page, "bots/list", {})).find(
    (b) => b.name === "Synthetic reader",
  )!;
  await expect(
    rpc(page, "bots/create", { name: "Rejected trader", tradingRole: "spot" }),
  ).rejects.toThrow(/400/);
  const trade = await createBusinessScope(page, "Synthetic trading");
  await expect(rpc(page, "bots/create", { name: "Rejected ordinary" })).rejects.toThrow(/400/);
  await expect(
    rpc(page, "bots/importCreate", {
      name: "Rejected import",
      files: [{ path: "AGENTS.md", content: "Synthetic ordinary bot" }],
      selection: { instructions: [], memory: [], skills: [] },
    }),
  ).rejects.toThrow();
  await openNewBot(page);
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(dialog.getByRole("radio", { name: "General bot", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  const trader = (await rpc<Bot[]>(page, "bots/list", {})).find((bot) => bot.tradingRole)!;
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  const access = page.getByTestId("workspace-material-access");
  await access.getByLabel("Recipient Bot", { exact: true }).selectOption(reader.id);
  await expect(access.getByLabel("Material", { exact: true }).locator("option")).not.toHaveCount(1);
  const material = await access
    .getByLabel("Material", { exact: true })
    .locator("option")
    .nth(1)
    .getAttribute("value");
  await access.getByLabel("Material", { exact: true }).selectOption(material!);
  await access.getByRole("button", { name: "Grant read access", exact: true }).click();
  await expect(access.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  const [grant] = await rpc<WorkspaceReadGrant[]>(page, "workspaceAccess/grants", {});
  await captureScreenshot(page, testInfo, "workspace-read-grant-en");
  await picker.getByLabel("Workspace", { exact: true }).selectOption(generalSpaceId);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(generalSpaceId);
  const received = await rpc<WorkspaceReadGrant[]>(page, "workspaceAccess/received", {
    botId: reader.id,
  });
  expect(received.map((row) => row.id)).toEqual([grant!.id]);
  const read = await rpc<{ material: { resourceId: string } }>(page, "workspaceAccess/read", {
    botId: reader.id,
    grantId: grant!.id,
  });
  expect(read.material.resourceId).toBe(grant!.resourceId);
  const copied = await rpc<Bot>(page, "bots/duplicate", { botId: reader.id });
  expect(copied.tradingRole).toBeNull();
  expect(await rpc(page, "workspaceAccess/received", { botId: copied.id })).toEqual([]);
  await picker.getByLabel("Workspace", { exact: true }).selectOption("");
  await page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${trader.id}"]`).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(trade.spaceId);
  await picker.getByLabel("Workspace", { exact: true }).selectOption(trade.spaceId);
  await page.getByRole("button", { name: "Interface settings", exact: true }).click();
  await access.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(access.getByText("Revoked", { exact: true }).first()).toBeVisible();
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(access).toContainText("资料只读授权");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "workspace-read-grant-narrow-zh");
});

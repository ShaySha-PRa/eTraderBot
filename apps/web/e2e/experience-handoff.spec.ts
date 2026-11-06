import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openBotPanelTab, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("exports a fixed experience package and imports it into another business's Bot", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `handoff-${Date.now()}@rakazo.test`, "password12", "Synthetic handoff QA");
  await completeOnboarding(page);

  // Source business: a specialist Bot and a Skill worth handing over.
  const sourceScope = await createBusinessScope(page, "Synthetic handoff source");
  const sourceBot = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic source spot",
    tradingRole: "spot",
    tradingWorkspaceId: sourceScope.id,
  });
  await rpc(page, "agentSkills/create", {
    name: "deviation-review",
    description: "Check day-ahead deviations",
    body: "# Deviation review\n\nCompare cleared and metered energy before proposing changes.",
  });
  await page.goto(`/app/${sourceBot.id}`);
  await openBotPanelTab(page, "Advanced");
  await page
    .getByTestId("bot-settings")
    .getByRole("button", { name: "Export experience", exact: true })
    .click();
  const exporter = page.getByTestId("experience-export");
  await exporter.locator('input[id$="-title"]').fill("Spot deviation playbook");
  // Same-named Bot and shared memories are told apart by their source before ticking.
  await expect(
    exporter.getByRole("checkbox", { name: "This Bot's memory MEMORY.md", exact: true }),
  ).toHaveCount(1);
  await expect(
    exporter.getByRole("checkbox", { name: "Shared memory MEMORY.md", exact: true }),
  ).toHaveCount(1);
  await exporter
    .getByRole("checkbox", { name: "Workspace Skill deviation-review", exact: true })
    .click();
  await exporter.getByLabel("Condition 1", { exact: true }).fill("Synthetic generator business");
  await exporter
    .locator("fieldset", { hasText: "Known limitations" })
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await exporter.getByLabel("Limitation 1", { exact: true }).fill("Not validated on real data");
  await exporter.getByRole("button", { name: "Add summary", exact: true }).click();
  await exporter.getByLabel("Summary title", { exact: true }).fill("Deviation lesson");
  await exporter
    .getByLabel("Summary", { exact: true })
    .fill("Forecast error, not price, drove most synthetic deviation.");
  await exporter.getByRole("button", { name: "Create package", exact: true }).click();
  const created = exporter.locator('details[data-testid^="handoff-package-"]');
  await expect(created).toHaveCount(1);
  await expect(created).toHaveAttribute("open", "");
  await expect(created).toContainText("Spot deviation playbook · v1");
  await expect(created).toContainText("Synthetic generator business");
  await expect(created).toContainText("Not validated on real data");
  await expect(created).toContainText("deviation-review");
  await captureScreenshot(page, testInfo, "experience-export-en");

  // Target business: its Bot already has a Skill with the same name.
  const targetScope = await createBusinessScope(page, "Synthetic handoff target");
  const targetBot = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic target spot",
    tradingRole: "spot",
    tradingWorkspaceId: targetScope.id,
  });
  await rpc(page, "agentSkills/create", {
    name: "deviation-review",
    description: "Existing target Skill",
    body: "# Existing target Skill",
  });
  await page.goto(`/app/${targetBot.id}`);
  await openBotPanelTab(page, "Advanced");
  await page
    .getByTestId("bot-settings")
    .getByRole("button", { name: "Import experience", exact: true })
    .click();
  const importer = page.getByTestId("experience-import");
  // The handoff page replaces the chat, composer included.
  await expect(importer).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Message Synthetic target spot" })).toHaveCount(
    0,
  );
  const choice = importer.getByLabel("Package", { exact: true });
  await choice.selectOption({ label: await choiceLabel() });
  const preview = importer.getByTestId("handoff-preview");
  await expect(preview).toContainText("Synthetic source spot · Synthetic handoff source · Trading");
  await expect(preview).toContainText("Synthetic generator business");
  await expect(preview).toContainText("Not validated on real data");
  // Each item gets a fresh name by default; reusing an existing Skill's name is a conflict.
  const skillRow = preview.locator('[data-testid^="handoff-plan-"]', { hasText: "Skill" });
  const skillName = skillRow.getByRole("textbox");
  await expect(skillName).toHaveValue(/^handoff-/);
  const importButton = importer.getByRole("button", { name: "Import", exact: true });
  const previewAgain = importer.getByRole("button", { name: "Preview again", exact: true });
  await skillName.fill("deviation-review");
  await expect(importButton).toBeDisabled();
  await previewAgain.click();
  await expect(skillRow).toContainText("This Bot already has something with this name");
  await expect(importButton).toBeDisabled();
  await captureScreenshot(page, testInfo, "experience-import-conflict-en");

  // Rename instead of overwrite, preview again, then confirm.
  await skillName.fill("deviation-review-imported");
  await expect(importButton).toBeDisabled();
  await previewAgain.click();
  await expect(skillRow).not.toContainText("already has");
  await expect(importButton).toBeEnabled();

  // A Skill lands under the chosen name meanwhile, so the server calls the preview stale.
  await rpc(page, "agentSkills/create", {
    name: "deviation-review-imported",
    description: "Arrived meanwhile",
    body: "# Arrived meanwhile",
  });
  await importButton.click();
  const refusal = importer.getByRole("alert");
  await expect(refusal).toHaveText("The target changed. Preview again before importing");
  await expect(skillName).toHaveValue("deviation-review-imported");
  await expect(importButton).toBeDisabled();
  await expect(previewAgain).toBeEnabled();
  // The shown refusal follows the interface language.
  const languages = page.getByTestId("language-switcher");
  await languages.getByRole("button", { name: "中文", exact: true }).click();
  await expect(refusal).toHaveText("目标已变化，请重新预览后再导入");
  await captureScreenshot(page, testInfo, "experience-import-stale-zh");
  await languages.getByRole("button", { name: "English", exact: true }).click();
  await expect(refusal).toHaveText("The target changed. Preview again before importing");
  // Previewing the same plan again reveals the new conflict; a fresh name then imports.
  await previewAgain.click();
  await expect(skillRow).toContainText("This Bot already has something with this name");
  await skillName.fill("deviation-review-handoff");
  await previewAgain.click();
  await expect(skillRow).not.toContainText("already has");
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(importer.getByTestId("handoff-receipt")).toContainText(
    "deviation-review-handoff · Waiting to be enabled",
  );

  // Imported memory is usable now; the imported Skill waits to be enabled.
  const experience = importer.getByTestId("imported-experience");
  await expect(experience).toContainText("Synthetic source spot v1");
  await expect(experience).not.toContainText("deviation-review");
  const skill = importer.getByTestId("imported-skill-deviation-review-handoff");
  await expect(skill).toContainText("Waiting to be enabled");
  await skill.getByRole("switch").click();
  await expect(skill).toContainText("Enabled");

  // History traces the import back to the package exactly as imported.
  const entry = importer.locator('details[data-testid^="handoff-import-"]');
  await expect(entry).toContainText("Synthetic source spot → Synthetic target spot · v1");
  await entry.locator("summary").click();
  await expect(entry).toContainText("Synthetic generator business");
  await captureScreenshot(page, testInfo, "experience-import-done-en");

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(importer).toContainText("已导入经验");
  await expect(importer).toContainText("导入的技能");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Opening the page from the panel closes the panel, so the page stays visible on a phone.
  await expect(page.getByTestId("bot-settings")).toBeHidden();
  await importer.getByTestId("imported-skills").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "experience-import-narrow-zh");

  async function choiceLabel() {
    // The package list loads after the page; wait for the new package to be offered.
    const options = importer.getByLabel("Package", { exact: true }).locator("option");
    await expect(options.filter({ hasText: "Spot deviation playbook · v1" })).toHaveCount(1);
    return (await options.filter({ hasText: "Spot deviation playbook · v1" }).textContent())!;
  }
});

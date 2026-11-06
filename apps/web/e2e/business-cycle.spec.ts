import { expect, test } from "@playwright/test";
import type { Bot, BusinessCycleState, TradingWorkspace } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { submitBusinessScope } from "./trading-business-helpers";

test("P25 business cycle links approvals, evidence, reconciliation and corrections", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `cycle-${Date.now()}@rakazo.test`, "password12", "Synthetic cycle QA");
  await completeOnboarding(page);
  await page
    .getByTestId("business-scope-picker")
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByTestId("business-scope-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Synthetic P25 business");
  await dialog.getByLabel("Subject type", { exact: true }).selectOption("generator");
  await submitBusinessScope(page, "Create workspace");
  await expect(
    page
      .getByTestId("business-scope-picker")
      .getByLabel("Workspace", { exact: true })
      .locator("option:checked"),
  ).toHaveText("Synthetic P25 business · Trading");
  const scope = (await rpc<TradingWorkspace[]>(page, "trading/workspaces", {}))[0]!;
  const team: Bot[] = [];
  for (const role of ["mid_long_term", "spot", "risk", "review"])
    team.push(
      await rpc<Bot>(page, "bots/create", {
        name: `Synthetic ${role}`,
        tradingRole: role,
        tradingWorkspaceId: scope.id,
      }),
    );
  const supervisor = (await rpc<Bot[]>(page, "bots/list", {})).find((b) => b.businessSupervisor)!;
  await page.goto("/app");
  await expect(page).toHaveURL(new RegExp(supervisor.id));
  await page
    .getByRole("navigation", { name: "Bot workspace", exact: true })
    .getByRole("button", { name: "Business cycle", exact: true })
    .click();
  const panel = page.getByTestId("business-cycle");
  await panel.getByRole("button", { name: "Load P25 simulation", exact: true }).click();
  await expect(panel.getByTestId("evidence-contracts")).toContainText("Contracts");
  await panel.getByRole("button", { name: "Assign necessary role", exact: true }).click();
  await expect(panel).toContainText("Contract coverage · todo");
  let state = await rpc<BusinessCycleState>(page, "businessCycle/get", {
    cycleId: await panel.getByLabel("Business cycle", { exact: true }).inputValue(),
  });
  expect(state.tasks).toHaveLength(1);
  expect(state.tasks[0]?.kind).toBe("contract_coverage");
  await panel.getByLabel("Requested work").selectOption("settlement_review");
  await panel.getByRole("button", { name: "Assign necessary role", exact: true }).click();
  await expect(panel).toContainText("Settlement review · blocked");
  await panel.getByRole("link", { name: "Open spot Bot", exact: true }).click();
  await panel.getByRole("button", { name: "Analyze shared evidence", exact: true }).click();
  await expect(panel).toContainText("90 MWh");
  await panel.getByRole("button", { name: "Prepare intent", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Submit simulation", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Approve algorithm", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Submit simulation", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Approve trade", exact: true }).click();
  await panel.getByRole("button", { name: "Submit simulation", exact: true }).click();
  await expect(panel.getByTestId("evidence-submission")).toBeVisible();
  await panel.getByRole("button", { name: "Import simulated results", exact: true }).click();
  await expect(panel.getByTestId("evidence-clearing:day_ahead")).toBeVisible();
  await expect(panel).toContainText("Settlement review · blocked");
  await panel.getByRole("button", { name: "Import simulated metering", exact: true }).click();
  await panel.getByRole("button", { name: "Reconcile settlement", exact: true }).click();
  await expect(panel.getByTestId("settlement-result")).toContainText("23700 CNY");
  await expect(panel.getByTestId("settlement-result")).toContainText("Not established");
  await expect(panel).toContainText("Settlement review · todo");
  const review = panel
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Settlement review · todo" }) });
  await review.locator("summary").click();
  await review
    .getByLabel("Human-recorded result")
    .fill(
      "Synthetic P25 energy settlement reconciled to 23,700 CNY. Costs are missing; net profit is not established.",
    );
  await review
    .getByLabel("Improvement proposal (not enabled)")
    .fill("Review forecast deviations on a separate dataset before proposing algorithm changes.");
  await review.getByRole("button", { name: "Record sourced result", exact: true }).click();
  await expect(panel).toContainText("Settlement review · done");
  await captureScreenshot(page, testInfo, "business-cycle-p25-en");
  state = await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id });
  expect(state.settlement?.equivalentDifferenceCny).toBe("23700");
  const oldCount = state.evidence.length;
  await panel.getByRole("button", { name: "Reconcile settlement", exact: true }).click();
  expect(
    (await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id }))
      .evidence,
  ).toHaveLength(oldCount);
  await panel.getByLabel("Actual energy (MWh)").fill("82");
  await panel.getByRole("button", { name: "Append metering correction", exact: true }).click();
  // Corrected inputs let review start again, but it cannot finish before a new settlement trial.
  const reopened = panel
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Settlement review · todo" }) });
  await expect(reopened).toContainText(
    "Ready to investigate · Needed to complete: evidence:settlement",
  );
  await expect(panel.getByTestId("settlement-result")).toBeHidden();
  if (!(await reopened.evaluate((node) => (node as HTMLDetailsElement).open)))
    await reopened.locator("summary").click();
  await reopened
    .locator('[id$="-summary"]')
    .fill("Metering was corrected to 82 MWh; the settlement trial must be recalculated.");
  // Completing without an open question is refused by the server; the reason reads in Chinese.
  const reviewForm = panel.getByTestId(
    `cycle-task-${state.tasks.find((t) => t.kind === "settlement_review")!.ticketId}`,
  );
  const languages = page.getByTestId("language-switcher");
  await languages.getByRole("button", { name: "中文", exact: true }).click();
  await reviewForm.getByRole("button", { name: "记录有据结果", exact: true }).click();
  await expect(reviewForm.getByRole("alert")).toHaveText("所需证据或前序任务结果尚未齐全");
  await expect(reviewForm.locator('[id$="-summary"]')).toHaveValue(
    "Metering was corrected to 82 MWh; the settlement trial must be recalculated.",
  );
  await captureScreenshot(page, testInfo, "business-cycle-refusal-zh");
  await languages.getByRole("button", { name: "English", exact: true }).click();
  await reopened.locator('[id$="-unresolved"]').fill("New settlement trial pending");
  await expect(reviewForm.getByRole("alert")).toHaveCount(0);
  await reopened.getByRole("button", { name: "Record sourced result", exact: true }).click();
  await expect(panel).toContainText("Settlement review · review");
  await expect(panel).not.toContainText("Settlement review · done");
  await panel.getByRole("button", { name: "Reconcile settlement", exact: true }).click();
  await expect(panel.getByTestId("settlement-result")).toContainText("24320 CNY");
  state = await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id });
  expect(
    state.evidence.some((e) => e.kind === "settlement" && e.data.energyAmountCny === "23700"),
  ).toBe(true);
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(panel).toContainText("业务周期");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "business-cycle-p25-narrow-zh");
  await page.goto(`/app/${team.find((b) => b.tradingRole === "risk")!.id}?workspace=cycle`);
  await expect(page.getByTestId("business-cycle")).toContainText("24320");
  await expect(page.getByRole("button", { name: "提交模拟申报", exact: true })).toHaveCount(0);
});

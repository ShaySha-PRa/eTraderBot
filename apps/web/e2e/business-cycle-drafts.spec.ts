import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, BusinessCycleState, TradingWorkspace } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

// Inputs sit inside their labels, so a filled value joins the accessible name; match by field id.
const fields = ["summary", "disagreements", "unresolved", "proposal"] as const;
type Field = (typeof fields)[number];
const input = (form: Locator, name: Field) => form.locator(`[id$="-${name}"]`);

/** A business (its own space) with the four specialist Bots and its supervisor. */
async function businessTeam(page: Page, name: string) {
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

async function openCycle(page: Page, supervisor: Bot, kinds: string[]) {
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

function taskForm(panel: Locator, state: BusinessCycleState, kind: string) {
  return panel.getByTestId(`cycle-task-${state.tasks.find((t) => t.kind === kind)!.ticketId}`);
}

async function fill(form: Locator, prefix: string) {
  for (const label of fields) await input(form, label).fill(`${prefix} ${label}`);
}

async function expectDraft(form: Locator, prefix: string | null) {
  for (const label of fields)
    await expect(input(form, label)).toHaveValue(prefix ? `${prefix} ${label}` : "");
}

function nextCompletion(page: Page) {
  return page.waitForRequest((r) => r.url().endsWith("/rpc/businessCycle/complete"));
}

test("parallel cycle tasks keep separate drafts through failure, refresh, completion and business switches", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `cycle-drafts-${Date.now()}@rakazo.test`, "password12", "Synthetic drafts QA");
  await completeOnboarding(page);
  const first = await businessTeam(page, "Synthetic drafts A");
  const { panel, state } = await openCycle(page, first.supervisor, [
    "contract_coverage",
    "risk_check",
  ]);
  const contract = taskForm(panel, state, "contract_coverage");
  const risk = taskForm(panel, state, "risk_check");
  await contract.locator("summary").click();
  await risk.locator("summary").click();
  await fill(contract, "Contract");
  await fill(risk, "Risk");
  await expectDraft(contract, "Contract");
  await expectDraft(risk, "Risk");

  // A failed submission leaves both drafts as typed.
  await page.route("**/rpc/businessCycle/complete", (route) => route.abort("failed"), {
    times: 1,
  });
  await risk.getByRole("button", { name: "Record sourced result", exact: true }).click();
  // The reason appears in the failed task's form only, not as a page-level message.
  await expect(risk.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(panel.getByRole("alert")).toHaveCount(1);
  await expect(contract.getByRole("alert")).toHaveCount(0);
  await expectDraft(risk, "Risk");
  await expectDraft(contract, "Contract");

  // An over-limit field is named with its limit before any request is sent.
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/rpc/businessCycle/complete")) sent++;
  });
  await input(contract, "disagreements").fill("x".repeat(2001));
  await contract.getByRole("button", { name: "Record sourced result", exact: true }).click();
  await expect(contract.getByRole("alert")).toHaveText(
    "Disagreements must be 2000 characters or fewer",
  );
  await expect(input(contract, "disagreements")).toHaveAttribute("aria-invalid", "true");
  await expect(input(contract, "disagreements")).toHaveValue("x".repeat(2001));
  expect(sent).toBe(0);
  await captureScreenshot(page, testInfo, "business-cycle-field-limit-en");
  await input(contract, "disagreements").fill("Contract disagreements");
  await expect(contract.getByRole("alert")).toHaveCount(0);
  await expectDraft(contract, "Contract");

  // The page polls the cycle; a refetch must not touch unsent input.
  await page.waitForResponse((r) => r.url().endsWith("/rpc/businessCycle/get"));
  await page.waitForResponse((r) => r.url().endsWith("/rpc/businessCycle/get"));
  await expectDraft(risk, "Risk");
  await expectDraft(contract, "Contract");

  // Risk is sent with its own ticket, text and evidence; it has no unresolved items so it closes.
  await input(risk, "unresolved").fill("");
  const riskRequest = nextCompletion(page);
  await risk.getByRole("button", { name: "Record sourced result", exact: true }).click();
  const evidence = (keys: string[]) =>
    state.evidence.filter((e) => keys.includes(e.streamKey)).map((e) => e.id);
  expect((await riskRequest).postDataJSON().json).toEqual({
    ticketId: state.tasks.find((t) => t.kind === "risk_check")!.ticketId,
    result: {
      summary: "Risk summary",
      evidenceIds: evidence(["contracts", "forecast", "asset"]),
      disagreements: ["Risk disagreements"],
      unresolved: [],
      improvementProposal: "Risk proposal",
    },
    // The draft was started before any result existed.
    expectedResultEvidenceId: null,
  });
  await expect(risk.locator("summary")).toContainText("Risk check · done");
  await expect(input(risk, "summary")).toHaveCount(0);
  await expectDraft(contract, "Contract");
  await captureScreenshot(page, testInfo, "business-cycle-drafts-en");

  // Another business mounts its own cycle page with empty forms.
  const second = await businessTeam(page, "Synthetic drafts B");
  expect(second.supervisor.id).not.toBe(first.supervisor.id);
  const other = await openCycle(page, second.supervisor, ["contract_coverage"]);
  expect(other.state.cycle.id).not.toBe(state.cycle.id);
  const otherContract = taskForm(other.panel, other.state, "contract_coverage");
  await otherContract.locator("summary").click();
  await expectDraft(otherContract, null);
  await fill(otherContract, "Second business");

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(other.panel).toContainText("业务周期");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectDraft(otherContract, "Second business");
  await captureScreenshot(page, testInfo, "business-cycle-drafts-narrow-zh");

  // Completing the second business task sends only its own draft; the first cycle stays untouched.
  const otherRequest = nextCompletion(page);
  await otherContract.getByRole("button", { name: "记录有据结果", exact: true }).click();
  expect((await otherRequest).postDataJSON().json).toMatchObject({
    ticketId: other.state.tasks[0]!.ticketId,
    result: {
      summary: "Second business summary",
      evidenceIds: other.state.evidence.filter((e) => e.streamKey === "contracts").map((e) => e.id),
    },
  });
  await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), first.scope.spaceId);
  const firstState = await rpc<BusinessCycleState>(page, "businessCycle/get", {
    cycleId: state.cycle.id,
  });
  expect(firstState.tasks.find((t) => t.kind === "contract_coverage")?.status).toBe("todo");
  expect(firstState.tasks.find((t) => t.kind === "risk_check")?.result?.summary).toBe(
    "Risk summary",
  );
});

test("an open board shows a cycle task completed without downstream work", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `cycle-board-${Date.now()}@rakazo.test`, "password12", "Synthetic board QA");
  await completeOnboarding(page);
  const { supervisor } = await businessTeam(page, "Synthetic board business");
  const { state } = await openCycle(page, supervisor, ["contract_coverage"]);
  const ticketId = state.tasks[0]!.ticketId;
  await page.goto("/app/board");
  const column = (name: string) =>
    page
      .getByTestId("board-columns")
      .locator("section")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(column("To do").getByTestId(`board-card-${ticketId}`)).toBeVisible();

  // Completed outside this page; only the board event can move the card.
  await rpc<BusinessCycleState>(page, "businessCycle/complete", {
    ticketId,
    result: {
      summary: "Synthetic contract coverage checked.",
      evidenceIds: state.evidence.filter((e) => e.streamKey === "contracts").map((e) => e.id),
      disagreements: [],
      unresolved: [],
      improvementProposal: null,
    },
  });
  await expect(column("Done").getByTestId(`board-card-${ticketId}`)).toBeVisible();
});

test("a task whose specialist was deleted can be restored to an eligible Bot", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(page, `cycle-owner-${Date.now()}@rakazo.test`, "password12", "Synthetic owner QA");
  await completeOnboarding(page);
  const { scope, supervisor } = await businessTeam(page, "Synthetic owner business");
  const { panel, state } = await openCycle(page, supervisor, ["contract_coverage"]);
  const contract = taskForm(panel, state, "contract_coverage");
  await contract.locator("summary").click();

  // An investigation with an open question stays in review rather than done.
  await input(contract, "summary").fill(
    "Contract coverage checked against the synthetic forecast.",
  );
  await input(contract, "unresolved").fill("Confirm settlement reference point");
  await contract.getByRole("button", { name: "Record sourced result", exact: true }).click();
  await expect(contract.locator("summary")).toContainText("Contract coverage · review");

  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const former = bots.find((b) => b.tradingRole === "mid_long_term")!;
  await expect(contract.locator("summary")).toContainText(former.name);
  await rpc(page, "bots/remove", { botId: former.id });
  await expect(contract.locator("summary")).toContainText("· Unassigned");
  const replacement = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic owner replacement",
    tradingRole: "mid_long_term",
    tradingWorkspaceId: scope.id,
  });
  // Only an active Bot with the task's specialist role is offered.
  const owner = contract.getByLabel("Assignee", { exact: true });
  await expect(owner.locator("option")).toHaveText([replacement.name]);
  await captureScreenshot(page, testInfo, "business-cycle-owner-missing-en");
  await contract.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(contract.locator("summary")).toContainText(replacement.name);
  await expect(owner).toHaveCount(0);
  const restored = (
    await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id })
  ).tasks[0]!;
  expect(restored.assigneeBotId).toBe(replacement.id);
  expect(restored.result?.summary).toBe(
    "Contract coverage checked against the synthetic forecast.",
  );
  await expect(contract.locator("summary")).toContainText(`· ${restored.status} ·`);
  await expect(contract).toContainText("Contract coverage checked against the synthetic forecast.");

  // Archiving the assignee elsewhere updates the open page without a reload.
  await rpc(page, "bots/archive", { botId: replacement.id });
  await expect(contract.locator("summary")).toContainText("· Archived");
  const second = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic owner second",
    tradingRole: "mid_long_term",
    tradingWorkspaceId: scope.id,
  });
  await expect(owner.locator("option")).toHaveText([second.name]);
  await captureScreenshot(page, testInfo, "business-cycle-owner-archived-en");
  await contract.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(contract.locator("summary")).toContainText(second.name);
  await expect(contract).toContainText("Contract coverage checked against the synthetic forecast.");
});

test("a result sent from an outdated draft is refused in Chinese at phone width and resent on the latest version", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cycle-conflict-${stamp}@rakazo.test`, "password12", "Cycle Conflict");
  await completeOnboarding(page);
  const { supervisor } = await businessTeam(page, "Synthetic conflict");
  const { panel, state } = await openCycle(page, supervisor, ["contract_coverage"]);
  const contract = taskForm(panel, state, "contract_coverage");
  await contract.locator("summary").click();
  await fill(contract, "Mine");

  // Someone else records a result first, from the same starting point as this draft.
  const ticketId = state.tasks[0]!.ticketId;
  const evidenceIds = state.evidence.filter((e) => e.streamKey === "contracts").map((e) => e.id);
  await rpc(page, "businessCycle/complete", {
    ticketId,
    result: {
      summary: "Theirs summary",
      evidenceIds,
      disagreements: [],
      unresolved: ["Theirs unresolved"],
      improvementProposal: null,
    },
    expectedResultEvidenceId: null,
  });

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(panel).toContainText("业务周期");
  await page.setViewportSize({ width: 390, height: 844 });
  const measured = await page.evaluate(() => ({
    innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    devicePixelRatio,
  }));
  await testInfo.attach("narrow-viewport", {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
  console.log(`narrow viewport: ${JSON.stringify(measured)}`);
  expect(measured.innerWidth).toBe(390);
  expect(measured.clientWidth).toBe(390);
  expect(measured.scrollWidth).toBeLessThanOrEqual(390);

  await contract.getByRole("button", { name: "记录有据结果", exact: true }).click();
  await expect(contract.getByRole("alert")).toHaveText("证据已更新，请核对最新版本后重新提交");
  await expectDraft(contract, "Mine");
  await contract.getByRole("alert").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "business-cycle-result-conflict-narrow-zh");
  const refused = await rpc<BusinessCycleState>(page, "businessCycle/get", {
    cycleId: state.cycle.id,
  });
  expect(refused.tasks[0]!.result?.summary).toBe("Theirs summary");

  // The refusal re-words with the interface language, then the draft is resent on the latest version.
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "English", exact: true })
    .click();
  await expect(contract.getByRole("alert")).toHaveText(
    "Evidence changed. Check the latest versions and submit again",
  );
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await contract.getByRole("button", { name: "使用最新版本", exact: true }).click();
  await expect(contract.getByRole("alert")).toHaveCount(0);
  await expectDraft(contract, "Mine");
  await contract.getByRole("button", { name: "记录有据结果", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id }))
          .tasks[0]!.result?.summary,
    )
    .toBe("Mine summary");
  await expect(contract.getByRole("alert")).toHaveCount(0);
  await contract.locator("summary").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "business-cycle-result-resent-narrow-zh");
});

import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, BusinessCycleState, RunTraceRow } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { businessTeam, openCycle } from "./trading-business-helpers";

const input = (form: Locator, name: string) => form.locator(`[id$="-${name}"]`);

async function measureNarrow(page: Page, testInfo: TestInfo) {
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
}

/** Restoring asks the person to confirm it's them when the session is not freshly verified. */
async function confirmIfAsked(page: Page) {
  const confirmation = page.getByRole("dialog", { name: /Confirm it's you|确认是你本人/ });
  const asked = await confirmation
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (asked) {
    await confirmation.getByLabel(/Password|密码/).fill("password12");
    await confirmation.getByRole("button", { name: /Continue|继续/ }).click();
    await expect(confirmation).toBeHidden();
  }
}

test("an archived specialist's unfinished task moves to a server-listed replacement in English and Chinese at phone width", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `replace-${stamp}@rakazo.test`, "password12", "Bot Replacement");
  await completeOnboarding(page);
  const { scope, supervisor } = await businessTeam(page, "Synthetic replacement");
  const { panel, state } = await openCycle(page, supervisor, ["contract_coverage"]);
  const ticketId = state.tasks[0]!.ticketId;
  const form = panel.getByTestId(`cycle-task-${ticketId}`);
  await form.locator("summary").click();

  // The original specialist records a result with an open question; the task stays in review.
  const evidenceIds = state.evidence.filter((e) => e.streamKey === "contracts").map((e) => e.id);
  await rpc(page, "businessCycle/complete", {
    ticketId,
    result: {
      summary: "Original contract summary",
      evidenceIds,
      disagreements: [],
      unresolved: ["Confirm settlement reference point"],
      improvementProposal: null,
    },
    expectedResultEvidenceId: null,
  });
  await expect(form.locator("summary")).toContainText("review");
  // An unsent draft on this page belongs to the business, not to the assignee.
  await input(form, "proposal").fill("Draft kept across the replacement");

  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const original = bots.find(
    (b) => b.tradingRole === "mid_long_term" && b.name.startsWith("Synthetic replacement"),
  )!;
  const keeper = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic keeper",
    tradingRole: "mid_long_term",
    tradingWorkspaceId: scope.id,
  });
  const leaving = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic leaving",
    tradingRole: "mid_long_term",
    tradingWorkspaceId: scope.id,
  });
  await expect(form.locator("summary")).toContainText(original.name);

  // Archived from another entry: the open page updates without a reload.
  await rpc(page, "bots/archive", { botId: original.id });
  await expect(form.locator("summary")).toContainText(`${original.name} (Archived)`);
  await expect(form).toContainText(`Assignee archived: ${original.name}`);
  await expect(form).toContainText("Blocked: Assignee archived");
  // Found by element so it survives the language switch; its name is checked in each language.
  const replacement = form.getByTestId("assignee-recovery").locator("select");
  await expect(replacement).toHaveAccessibleName("Replacement");
  // The contract does not order candidates; both listed replacements are offered.
  await expect(replacement.locator("option")).toHaveCount(2);
  await expect(replacement.locator("option", { hasText: keeper.name })).toHaveCount(1);
  await expect(replacement.locator("option", { hasText: leaving.name })).toHaveCount(1);
  await expect(replacement.locator("option", { hasText: original.name })).toHaveCount(0);
  await expect(replacement.locator("option", { hasText: supervisor.name })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "replacement-archived-en");

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(panel).toContainText("业务周期");
  await measureNarrow(page, testInfo);
  await expect(form).toContainText(`负责人已归档：${original.name}`);
  await expect(replacement).toHaveAccessibleName("替代负责人");

  // A candidate archived after the list was read is refused by the server, beside the task.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/businessCycle/recovery", async (route) => {
    await held;
    // A request held past the unroute below may already be settled by Playwright.
    await route.continue().catch(() => undefined);
  });
  await replacement.selectOption(leaving.id);
  await rpc(page, "bots/archive", { botId: leaving.id });
  const refused = page.waitForResponse((r) => r.url().endsWith("/rpc/tickets/update"));
  await form.getByRole("button", { name: "恢复", exact: true }).click();
  await confirmIfAsked(page);
  const response = await refused;
  expect([403, 404]).toContain(response.status());
  await expect(form.getByRole("alert")).toHaveText(/此 Bot 不能接手该任务|此 Bot 已不可用/);
  await form.getByRole("alert").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "replacement-refused-narrow-zh");
  let current = await rpc<BusinessCycleState>(page, "businessCycle/get", {
    cycleId: state.cycle.id,
  });
  expect(current.tasks[0]!.assigneeBotId).toBe(original.id);
  release();
  await page.unroute("**/rpc/businessCycle/recovery");
  await expect(replacement.locator("option")).toHaveText([keeper.name]);

  // The listed replacement takes the same ticket and cycle; history and the draft stay.
  await form.getByRole("button", { name: "恢复", exact: true }).click();
  await confirmIfAsked(page);
  await expect(form.locator("summary")).toContainText(keeper.name);
  await expect(replacement).toHaveCount(0);
  await expect(form).toContainText("Original contract summary");
  await expect(form).toContainText("Confirm settlement reference point");
  await expect(form).toContainText(evidenceIds[0]!);
  await expect(input(form, "proposal")).toHaveValue("Draft kept across the replacement");
  current = await rpc<BusinessCycleState>(page, "businessCycle/get", { cycleId: state.cycle.id });
  expect(current.cycle.id).toBe(state.cycle.id);
  expect(current.tasks[0]!.ticketId).toBe(ticketId);
  expect(current.tasks[0]!.assigneeBotId).toBe(keeper.id);
  expect(current.tasks[0]!.result?.unresolved).toEqual(["Confirm settlement reference point"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await form.locator("summary").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "replacement-restored-narrow-zh");

  // The new assignee continues the same ticket in its own run.
  await expect
    .poll(
      async () =>
        (await rpc<{ runs: RunTraceRow[] }>(page, "runs/forTicket", { ticketId })).runs.some(
          (run) => run.botId === keeper.id,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
});

import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { BusinessCycleState } from "@rakazo/contracts";
import { createDb } from "../../../packages/db/src/index";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { businessTeam, openCycle } from "./trading-business-helpers";

const fields = ["summary", "disagreements", "unresolved", "proposal"] as const;
const input = (form: Locator, name: (typeof fields)[number]) => form.locator(`[id$="-${name}"]`);
const taskForm = (panel: Locator, state: BusinessCycleState) =>
  panel.getByTestId(`cycle-task-${state.tasks[0]!.ticketId}`);

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

test("losing a business keeps the unsent result, writes nothing, never carries it into another business, and never sends it on return", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const email = `revoked-${stamp}@rakazo.test`;
  await signup(page, email, "password12", "Revoked Access");
  await completeOnboarding(page);

  // Business B stays available; business A is the one whose access is removed.
  const other = await businessTeam(page, "Synthetic kept B");
  const otherCycle = await openCycle(page, other.supervisor, ["contract_coverage"]);
  const lost = await businessTeam(page, "Synthetic revoked A");
  const { panel, state } = await openCycle(page, lost.supervisor, ["contract_coverage"]);
  const form = taskForm(panel, state);
  await form.locator("summary").click();
  for (const name of fields) await input(form, name).fill(`Revoked ${name}`);

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(panel).toContainText("业务周期");
  await measureNarrow(page, testInfo);

  const { prisma: db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const ticketId = state.tasks[0]!.ticketId;
    const snapshot = async () => ({
      evidence: await db.businessEvidence.count({ where: { cycleId: state.cycle.id } }),
      comments: await db.ticketComment.count({ where: { ticketId } }),
      ticket: await db.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { status: true, updatedAt: true },
      }),
    });
    const before = await snapshot();

    // Hold the shell's "which businesses do I still have" check so the refusal can be seen
    // before the page leaves; the request itself is sent unchanged once released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/rpc/spaces/list", async (route) => {
      await held;
      await route.continue();
    });

    // Remove this user's membership of business A in the isolated test database.
    const membership = await db.spaceMember.findUniqueOrThrow({
      where: { spaceId_userId: { spaceId: lost.scope.spaceId, userId: user.id } },
    });
    await db.spaceMember.delete({ where: { id: membership.id } });

    const refused = page.waitForResponse((r) => r.url().endsWith("/rpc/businessCycle/complete"));
    await form.getByRole("button", { name: "记录有据结果", exact: true }).click();
    const response = await refused;
    expect(response.status()).toBe(401);
    expect(JSON.stringify(await response.json())).toContain("UNAUTHORIZED");
    await expect(form.getByRole("alert")).toHaveText("你已无权访问此业务");
    for (const name of fields) await expect(input(form, name)).toHaveValue(`Revoked ${name}`);
    await form.getByRole("alert").scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "revoked-refusal-narrow-zh");
    expect(await snapshot()).toEqual(before);

    // The shell then leaves the lost business and says why.
    release();
    await expect(page.getByText("你已无权访问之前的业务", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.unroute("**/rpc/spaces/list");
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).not.toBe(
      lost.scope.spaceId,
    );
    await expect(page.getByText(/Revoked /)).toHaveCount(0);
    await captureScreenshot(page, testInfo, "revoked-left-narrow-zh");

    // Business B opens clean and sends only its own task.
    await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), other.scope.spaceId);
    await page.goto(`/app/${other.supervisor.id}?workspace=cycle`);
    const otherPanel = page.getByTestId("business-cycle");
    const otherForm = taskForm(otherPanel, otherCycle.state);
    await otherForm.locator("summary").click();
    for (const name of fields) await expect(input(otherForm, name)).toHaveValue("");
    await expect(page.getByText(/Revoked /)).toHaveCount(0);
    await input(otherForm, "summary").fill("Kept business summary");
    const sent = page.waitForRequest((r) => r.url().endsWith("/rpc/businessCycle/complete"));
    await otherForm.getByRole("button", { name: "记录有据结果", exact: true }).click();
    const body = (await sent).postDataJSON().json;
    expect(body.ticketId).toBe(otherCycle.state.tasks[0]!.ticketId);
    expect(body.ticketId).not.toBe(ticketId);
    expect(body.expectedResultEvidenceId).toBeNull();
    expect(body.result.evidenceIds).not.toEqual(
      expect.arrayContaining(state.evidence.map((e) => e.id)),
    );
    await captureScreenshot(page, testInfo, "revoked-other-business-narrow-zh");
    expect(await snapshot()).toEqual(before);

    // Access returns: the draft is back in its form, unsent, until the person sends it.
    await db.spaceMember.create({ data: membership });
    let completions = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/rpc/businessCycle/complete")) completions += 1;
    });
    await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), lost.scope.spaceId);
    await page.goto(`/app/${lost.supervisor.id}?workspace=cycle`);
    const backPanel = page.getByTestId("business-cycle");
    const backForm = taskForm(backPanel, state);
    await backForm.locator("summary").click();
    for (const name of fields) await expect(input(backForm, name)).toHaveValue(`Revoked ${name}`);
    // Two of the page's own refresh cycles pass without any submission.
    await page.waitForResponse((r) => r.url().endsWith("/rpc/businessCycle/get"));
    await page.waitForResponse((r) => r.url().endsWith("/rpc/businessCycle/get"));
    expect(completions).toBe(0);
    expect(await snapshot()).toEqual(before);
    await backForm.locator("summary").scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "revoked-restored-draft-narrow-zh");

    // Sending it is the person's choice, and then it records once.
    await backForm.getByRole("button", { name: "记录有据结果", exact: true }).click();
    await expect.poll(async () => (await snapshot()).evidence).toBe(before.evidence + 1);
    expect(completions).toBe(1);
  } finally {
    await pool.end();
  }
});

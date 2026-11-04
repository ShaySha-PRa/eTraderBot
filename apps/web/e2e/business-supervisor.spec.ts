import { expect, test } from "@playwright/test";
import type { Bot, Ticket } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("each business has a supervisor with a real task board and progress", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signup(
    page,
    `supervisor-${Date.now()}@rakazo.test`,
    "password12",
    "Synthetic supervisor QA",
  );
  await completeOnboarding(page);
  const scope = await createBusinessScope(page, "Synthetic operations");
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const supervisor = bots.find((bot) => bot.businessSupervisor)!;
  expect(supervisor).toBeTruthy();
  expect(supervisor.tradingRole).toBeNull();
  const specialist = await rpc<Bot>(page, "bots/create", {
    name: "Synthetic spot specialist",
    tradingRole: "spot",
    tradingWorkspaceId: scope.id,
  });
  await page.goto(`/app/${supervisor.id}?workspace=trading`);
  const panel = page.getByTestId("business-supervisor");
  await expect(panel).toContainText("Completed tasks");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "0");
  await panel.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New ticket", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill("Check synthetic exposure");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Review the synthetic case and record the evidence. Do not execute a trade.");
  await dialog.getByLabel("Owner").selectOption({ label: specialist.name });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  const tasks = await rpc<{ tickets: Ticket[] }>(page, "tickets/list", {});
  const ticket = tasks.tickets.find((task) => task.title === "Check synthetic exposure")!;
  expect(ticket.assigneeBotId).toBe(specialist.id);
  await rpc(page, "tickets/comment", {
    ticketId: ticket.id,
    body: "Synthetic result: exposure reviewed; approval remains with the human.",
  });
  await rpc(page, "tickets/update", { id: ticket.id, status: "done" });
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "100", { timeout: 15000 });
  await panel.getByText("Team and recent results", { exact: true }).click();
  await expect(panel).toContainText("approval remains with the human");
  await expect(rpc(page, "bots/duplicate", { botId: supervisor.id })).rejects.toThrow(/400/);
  await captureScreenshot(page, testInfo, "business-supervisor-en");
  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await expect(panel).toContainText("业务总览");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "business-supervisor-narrow-zh");
  await page
    .getByRole("navigation", { name: "Bot 工作区", exact: true })
    .getByRole("button", { name: "聊天", exact: true })
    .click();
  await expect(panel).toBeHidden();
});

import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { createBusinessScope } from "./trading-business-helpers";

test("a skill remains restricted until explicitly shared with another business", async ({
  page,
}, testInfo) => {
  await signup(page, `availability-${Date.now()}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const home = await rpc<{ current: { id: string } }>(page, "spaces/list", {});
  const skill = await rpc<{ id: string }>(page, "agentSkills/create", {
    content: [
      "---",
      "name: weekly-review",
      "description: Summarize the week's progress and blockers.",
      "---",
      "",
      "List what shipped, what slipped, and what is blocked.",
    ].join("\n"),
  });

  await rpc(page, "availability/set", {
    kind: "skill",
    id: skill.id,
    allSpaces: false,
    spaceIds: [home.current.id],
  });
  const clients = await createBusinessScope(page, "Clients");
  const clientSkills = await rpc<Array<{ id: string }>>(page, "agentSkills/list", {});
  expect(clientSkills.some((row) => row.id === skill.id)).toBe(false);
  await page
    .getByTestId("business-scope-picker")
    .getByLabel("Business scope", { exact: true })
    .selectOption(home.current.id);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const skills = page.getByRole("dialog", { name: "Skills", exact: true });
  const yours = skills.getByTestId("your-skills");
  await yours.getByRole("button", { name: /weekly-review/ }).click();
  const availability = yours.getByTestId("availability");
  await expect(availability).toContainText("Available in");
  await availability.getByRole("button", { name: /Default business scope/ }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Default business scope" }),
  ).toBeChecked();
  await expect(page.getByRole("menuitemcheckbox", { name: "Clients" })).not.toBeChecked();
  await captureScreenshot(page, testInfo, "skill-available-in");
  await page.getByRole("menuitemcheckbox", { name: "Clients", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ id: string; availability: { spaceIds: string[] } }>>(
            page,
            "availability/items",
            {},
          )
        ).find((row) => row.id === skill.id)?.availability.spaceIds,
    )
    .toContain(clients.spaceId);
});

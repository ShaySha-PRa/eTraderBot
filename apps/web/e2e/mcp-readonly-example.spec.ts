import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, rpc, signup } from "./helpers";
import { businessTeam, createBusinessScope } from "./trading-business-helpers";

type Assignment = { botId: string; serverId: string };

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

test("a read-only example connection is added off, limited to one Bot, then switched on, without echoing its credential or crossing businesses", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  // A fictional token for the synthetic example only.
  const credential = `synthetic-readonly-e2e-${stamp}`;
  await signup(page, `readonly-${stamp}@rakazo.test`, "password12", "Readonly Example");
  await completeOnboarding(page);
  // Business B exists first; business A, created after it, is the one selected.
  const otherBusiness = await createBusinessScope(page, "Synthetic readonly B");
  await businessTeam(page, "Synthetic readonly A");
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const target = bots.find((b) => b.tradingRole === "risk")!;
  const other = bots.find((b) => b.tradingRole === "review")!;

  // Another connection already given to a different Bot must keep its assignment.
  const existing = await rpc<McpServer>(page, "mcp/servers/create", {
    slug: "existing-docs",
    name: "Existing docs",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    headers: {},
    enabled: true,
  });
  await rpc(page, "mcp/servers/agents", { id: existing.id, allBots: false, botIds: [other.id] });

  // Browser journeys route MCP traffic through the shared connector emulator, which cannot reach
  // a local example process; this checks configuration and access only, not tool discovery.
  const endpoint = "https://mcp.example.test/readonly";
  {
    const sent: { path: string; body: unknown }[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/rpc\/mcp\/servers\/(create|agents|update)$/.test(path))
        sent.push({ path: path.replace("/rpc/mcp/servers/", ""), body: request.postDataJSON() });
    });
    const responses: string[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("/rpc/mcp/"))
        responses.push(await response.text().catch(() => ""));
    });

    await page.getByRole("button", { name: "Connect apps", exact: true }).click();
    await openIntegrationsAdd(page, "Manage MCP servers");
    // With a connection already listed, the form opens from the list.
    await page.getByRole("button", { name: "Add server", exact: true }).first().click();
    await page.getByLabel("Server name").fill("Synthetic readonly example");
    await page.getByLabel("Server URL").fill(endpoint);
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByLabel("Access token (optional)").fill(credential);

    // Only the target Bot may use it.
    const form = page.getByRole("dialog", { name: "MCP servers", exact: true });
    const access = form.getByRole("button", { name: "All bots", exact: true }).last();
    await access.click();
    const items = page.getByRole("menuitemcheckbox");
    const names = (await items.allTextContents()).filter(
      (name) => name !== "All bots" && name !== target.name,
    );
    for (const name of names) {
      if (!(await items.first().isVisible())) await access.click();
      await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add server", exact: true }).last().click();

    const card = page.getByTestId("mcp-server").filter({ hasText: "Synthetic readonly example" });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Created off, given its Bot, then switched on; the switch-on sends no credential back.
    expect(sent.map((s) => s.path)).toEqual(["create", "agents", "update"]);
    const [create, agents, update] = sent.map((s) => (s.body as { json: unknown }).json) as [
      { enabled: boolean; secret?: string },
      { allBots: boolean; botIds: string[] },
      { config: { enabled: boolean; secret?: string } },
    ];
    expect(create.enabled).toBe(false);
    expect(agents).toMatchObject({ allBots: false, botIds: [target.id] });
    expect(update.config.enabled).toBe(true);
    expect(JSON.stringify(update)).not.toContain(credential);
    expect(responses.join("\n")).not.toContain(credential);
    await expect(page.getByText(credential)).toHaveCount(0);

    const [server] = (await rpc<McpServer[]>(page, "mcp/servers/list", undefined)).filter(
      (s) => s.slug !== existing.slug,
    );
    expect(server).toMatchObject({ enabled: true, allBots: false, hasSecret: true });
    const assignments = await rpc<Assignment[]>(page, "mcp/assignments/all", undefined);
    expect(assignments.filter((a) => a.serverId === server!.id).map((a) => a.botId)).toEqual([
      target.id,
    ]);
    expect(assignments).toContainEqual(
      expect.objectContaining({ serverId: existing.id, botId: other.id }),
    );

    // Editing shows that a credential is stored, never the credential itself.
    await page.getByRole("button", { name: "Actions for Synthetic readonly example" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page.getByText("Advanced", { exact: true }).click();
    await expect(page.getByLabel("Access token (optional)")).toHaveValue("");
    await captureScreenshot(page, testInfo, "readonly-connection-en");
    await page.keyboard.press("Escape");

    // The same list in Chinese on a phone-width screen.
    await page
      .getByTestId("language-switcher")
      .getByRole("button", { name: "中文", exact: true })
      .click();
    await measureNarrow(page, testInfo);
    await page.goto(page.url());
    // At phone width the sidebar opens from the header.
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "连接应用", exact: true }).click();
    const integrations = page.getByRole("dialog").last();
    await integrations.getByRole("button", { name: /添加自定义/ }).click();
    await page.getByRole("menuitem", { name: /管理 MCP/ }).click();
    const zhCard = page.getByTestId("mcp-server").filter({ hasText: "Synthetic readonly example" });
    await expect(zhCard).toBeVisible();
    // The name keeps readable width at phone size instead of being squeezed out by its controls.
    const nameBox = await zhCard
      .getByText("Synthetic readonly example", { exact: true })
      .boundingBox();
    expect(nameBox?.width ?? 0).toBeGreaterThan(120);
    // Every control, including the actions menu, stays inside the dialog.
    const dialogBox = await page.getByRole("dialog", { name: "MCP 服务器" }).boundingBox();
    const actionsBox = await zhCard
      .getByRole("button", { name: "Synthetic readonly example 的操作" })
      .boundingBox();
    expect(actionsBox).not.toBeNull();
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await captureScreenshot(page, testInfo, "readonly-connection-narrow-zh");

    // Another business sees neither the connection nor business A's Bots.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), otherBusiness.spaceId);
    await page.goto("/app");
    const inB = await rpc<McpServer[]>(page, "mcp/servers/list", undefined);
    expect(inB.map((s) => s.id)).not.toContain(server!.id);
    // At phone width the sidebar opens from the header.
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "连接应用", exact: true }).click();
    await page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: /添加自定义/ })
      .click();
    await page.getByRole("menuitem", { name: /管理 MCP/ }).click();
    await expect(
      page.getByTestId("mcp-server").filter({ hasText: "Synthetic readonly example" }),
    ).toHaveCount(0);
    await captureScreenshot(page, testInfo, "readonly-other-business-narrow-zh");
  }
});

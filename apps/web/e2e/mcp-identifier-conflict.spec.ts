import { expect, test } from "@playwright/test";
import { deriveMcpSlug } from "@rakazo/core";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("adding a connection whose identifier is taken says so in Chinese at phone width and keeps the form", async ({
  page,
}, testInfo) => {
  await signup(page, `mcp-conflict-${Date.now()}@rakazo.test`, "password12", "MCP Conflict");
  await completeOnboarding(page);
  const name = "Synthetic readonly conflict";
  // An existing connection already holds the identifier this name derives.
  await rpc(page, "mcp/servers/create", {
    slug: deriveMcpSlug(name),
    name: "Existing connection",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/existing",
    headers: {},
    enabled: true,
  });

  await page
    .getByTestId("language-switcher")
    .getByRole("button", { name: "中文", exact: true })
    .click();
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

  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "连接应用", exact: true }).click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: /添加自定义/ })
    .click();
  await page.getByRole("menuitem", { name: /管理 MCP/ }).click();
  await page.getByRole("button", { name: "添加服务器", exact: true }).first().click();
  await page.locator("#mcp-name").fill(name);
  await page.locator("#mcp-endpoint").fill("https://mcp.example.test/new");

  const refused = page.waitForResponse((r) => r.url().endsWith("/rpc/mcp/servers/create"));
  await page.getByRole("button", { name: "添加服务器", exact: true }).last().click();
  expect((await refused).status()).toBe(409);
  await expect(
    page.getByText("已有连接使用此标识，请更换名称或使用现有连接", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("An MCP server with that identifier already exists.")).toHaveCount(0);
  await expect(page.locator("#mcp-name")).toHaveValue(name);
  await expect(page.locator("#mcp-endpoint")).toHaveValue("https://mcp.example.test/new");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "mcp-identifier-conflict-narrow-zh");
});

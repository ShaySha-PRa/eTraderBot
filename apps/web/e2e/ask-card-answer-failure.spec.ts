import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

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

test("an answer card keeps refused answers and drops a lost response's error once accepted", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ask-failure-${stamp}@rakazo.test`, "password12", "Ask Failure");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByPlaceholder(/Message/).fill("Ask me which city to use");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? null,
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  // threads/get can observe waiting_input before the realtime feed paints the ask card.
  const question = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await question.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(question).toBeVisible({ timeout: 15_000 });
  await measureNarrow(page, testInfo);

  await page.getByRole("button", { name: "Edit first", exact: true }).click();
  // Named in either language so the locator survives a language switch.
  const field = page.getByRole("textbox", { name: /^(Answer|回答)$/ });
  await field.fill("Shanghai");
  const languages = page.getByTestId("language-switcher");

  // A refused answer keeps the input and a translated reason, never the server's raw text.
  await page.route("**/rpc/threads/answer", (route) =>
    route.fulfill({
      status: 409,
      json: {
        json: {
          defined: false,
          code: "CONFLICT",
          status: 409,
          message: "This prompt is no longer awaiting an answer",
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(
    page.getByText("This question is no longer waiting for an answer", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("This prompt is no longer awaiting an answer")).toHaveCount(0);
  await expect(field).toHaveValue("Shanghai");
  await captureScreenshot(page, testInfo, "ask-answer-refused-narrow-en");

  await languages.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.getByText("该问题已不再等待回答", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("Shanghai");
  await captureScreenshot(page, testInfo, "ask-answer-refused-narrow-zh");
  await page.unroute("**/rpc/threads/answer");

  // A request that never reached the server keeps the input and says so.
  await page.route("**/rpc/threads/answer", (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "Service Unavailable" }),
  );
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(page.getByText("无法连接服务器", { exact: true })).toBeVisible();
  await expect(page.getByText("该问题已不再等待回答", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Cannot parse response body/)).toHaveCount(0);
  await expect(field).toHaveValue("Shanghai");
  await captureScreenshot(page, testInfo, "ask-answer-unreachable-narrow-zh");
  await page.unroute("**/rpc/threads/answer");

  // The server accepts the answer but its response is lost; the live update clears the error.
  let accepted = 0;
  await page.route("**/rpc/threads/answer", async (route) => {
    const upstream = await route.fetch();
    if (upstream.ok()) accepted += 1;
    await route.fulfill({ status: 502, contentType: "text/plain", body: "Bad Gateway" });
  });
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(page.getByTestId("ask-answer").filter({ hasText: "Shanghai" })).toBeVisible({
    timeout: 30_000,
  });
  expect(accepted).toBe(1);
  await expect(page.getByText("无法连接服务器", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Cannot parse response body/)).toHaveCount(0);
  await expect(field).toHaveCount(0);
  // The run resumes once with the accepted answer.
  await expect(page.getByText("done. i handled: Shanghai", { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "ask-answer-accepted-narrow-zh");

  await languages.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByText("Could not reach the server", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "ask-answer-accepted-narrow-en");
  await page.unroute("**/rpc/threads/answer");
});

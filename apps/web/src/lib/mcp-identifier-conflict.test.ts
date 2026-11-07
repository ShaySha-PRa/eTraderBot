import { beforeEach, expect, it, vi } from "vitest";

const language = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    (language.locale === "en" ? "" : `[${language.locale}] `) + String.raw(parts, ...values),
}));

import { mcpIdentifierConflictText } from "./mcp-identifier-conflict";

const conflict = (message: string) => Object.assign(new Error(message), { code: "CONFLICT" });
const HINT =
  "A connection already uses this identifier. Choose another name or use the existing connection.";

beforeEach(() => {
  language.locale = "en";
});

it("names an identifier conflict for both of the server's MCP identifier refusals", () => {
  expect(
    mcpIdentifierConflictText(conflict("An MCP server with that identifier already exists.")),
  ).toBe(HINT);
  expect(
    mcpIdentifierConflictText(
      conflict("An MCP server with that identifier already exists in one of these spaces."),
    ),
  ).toBe(HINT);
});

it("follows the interface language", () => {
  language.locale = "zh-CN";
  expect(
    mcpIdentifierConflictText(conflict("An MCP server with that identifier already exists.")),
  ).toBe(`[zh-CN] ${HINT}`);
});

it("leaves every other conflict, and the same words without a conflict code, alone", () => {
  expect(
    mcpIdentifierConflictText(conflict("The stored credential changed. Reload and try again.")),
  ).toBeNull();
  expect(
    mcpIdentifierConflictText(
      conflict("A skill with that name already exists in one of these spaces."),
    ),
  ).toBeNull();
  expect(
    mcpIdentifierConflictText(
      Object.assign(new Error("An MCP server with that identifier already exists."), {
        code: "BAD_REQUEST",
      }),
    ),
  ).toBeNull();
  expect(mcpIdentifierConflictText(new TypeError("Failed to fetch"))).toBeNull();
  expect(mcpIdentifierConflictText(undefined)).toBeNull();
});

import { McpServerConfigInput } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveMcpSlug } from "./mcp.js";

afterEach(() => vi.restoreAllMocks());

describe("deriveMcpSlug", () => {
  it.each([
    ["!_-_LOCAL!", "local"],
    [`${"_".repeat(80)}local`, "local"],
    ["9 Local", "9-local"],
    ["Local_MCP_", "local_mcp_"],
    ["Brex MCP Server!", "brex-mcp-server"],
    ["x".repeat(100), "x".repeat(64)],
  ])("derives a backend-valid slug for %j", (name, expected) => {
    const slug = deriveMcpSlug(name);

    expect(slug).toBe(expected);
    expect(
      McpServerConfigInput.safeParse({
        name: "Synthetic MCP server",
        slug,
        transport: "stdio",
        command: "demo",
      }).success,
    ).toBe(true);
  });

  it.each(["", "-_!-_"])("uses a backend-valid fallback when %j has no slug characters", (name) => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const slug = deriveMcpSlug(name);

    expect(slug).toBe("mcp-1700000000000");
    expect(
      McpServerConfigInput.safeParse({
        name: "Synthetic MCP server",
        slug,
        transport: "stdio",
        command: "demo",
      }).success,
    ).toBe(true);
  });

  it("preserves normalization collisions for the existing duplicate-server handling", () => {
    expect(deriveMcpSlug(" Local MCP ")).toBe(deriveMcpSlug("Local MCP!"));
  });

  it.each([
    ["08 基线分配", "08 合成只读样例"],
    ["世界", "天气"],
    ["天气 🌧️", "天气 ☀️"],
    [`${"a".repeat(80)}基线`, `${"a".repeat(80)}样例`],
  ])("retains the distinction between Unicode names %j and %j", (first, second) => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const slugs = [deriveMcpSlug(first), deriveMcpSlug(second)];
    expect(slugs[0]).not.toBe(slugs[1]);
    for (const slug of slugs) {
      expect(slug.length).toBeLessThanOrEqual(64);
      expect(
        McpServerConfigInput.safeParse({ name: first, slug, transport: "stdio", command: "demo" })
          .success,
      ).toBe(true);
    }
  });

  it("is deterministic across time and Unicode canonical forms", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValueOnce(2);
    expect(deriveMcpSlug("世界")).toBe(deriveMcpSlug(" 世界 "));
    expect(deriveMcpSlug("Cafe\u0301 天气")).toBe(deriveMcpSlug("Café 天气"));
    expect(deriveMcpSlug("08 合成只读样例")).not.toBe("08");
  });
});

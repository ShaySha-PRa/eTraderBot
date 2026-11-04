import { describe, expect, it } from "vitest";
import { TradingInterfaceConfigSchema, TradingWorkspaceScopeSchema } from "./trading-workspace.js";

describe("business interface configuration", () => {
  it.each([
    "not-a-url",
    "ftp://api.example.test/data",
    "https://user:secret@api.example.test/data",
    "https://api.example.test/data#secret",
  ])("rejects unsupported or credential-bearing URL %s", (url) => {
    expect(TradingInterfaceConfigSchema.safeParse({ transport: "http", url }).success).toBe(false);
  });
  it("accepts ordinary data APIs with explicit query-key authentication", () => {
    expect(
      TradingInterfaceConfigSchema.parse({
        transport: "http",
        url: "http://localhost:8095/prices",
        query: { market: "synthetic" },
        auth: "query",
        authName: "api_key",
      }),
    ).toMatchObject({ method: "GET", body: "", authName: "api_key" });
  });
  it("requires the key field name and rejects GET bodies or non-string query values", () => {
    const base = { transport: "http", url: "https://api.example.test/data" };
    for (const change of [
      { auth: "header" },
      { auth: "header", authName: "Bad\r\nHeader" },
      { body: "{}" },
      { query: { count: 4 } },
    ])
      expect(TradingInterfaceConfigSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });
  it("keeps trading stage outside the business scope", () => {
    const scope = {
      subjectId: "synthetic",
      subjectKind: "storage",
      accountId: "synthetic",
      assetId: "synthetic",
      region: "CN-SD",
      marketId: "synthetic",
      productId: "energy",
      environment: "simulation",
    };
    expect(TradingWorkspaceScopeSchema.safeParse(scope).success).toBe(true);
    expect(TradingWorkspaceScopeSchema.safeParse({ ...scope, stage: "day_ahead" }).success).toBe(
      false,
    );
  });
});

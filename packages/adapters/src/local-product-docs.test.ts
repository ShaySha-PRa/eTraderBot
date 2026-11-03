import { describe, expect, it } from "vitest";
import { localProductDoc } from "./local-product-docs.js";

describe("local product docs", () => {
  it("serves the local getting-started and fleet documentation", () => {
    expect(localProductDoc("http://localhost:5173/docs.md")).toContain("eTraderBot");
    expect(localProductDoc("http://localhost:5173/docs/fleet-management.md")).toContain("#");
  });

  it("does not turn arbitrary localhost URLs or paths into local file access", () => {
    for (const url of [
      "http://localhost:5173/docs.md?secret=1",
      "http://localhost:5173/docs/../../.env.md",
      "http://localhost:5173/internal/health",
      "http://localhost:9999/docs.md",
    ])
      expect(localProductDoc(url)).toBeUndefined();
  });
});

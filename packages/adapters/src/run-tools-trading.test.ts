import { BusinessAssignInputSchema, BusinessCycleCommandSchema } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tradingTools } from "./run-tools-trading.js";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  assign: vi.fn(),
  analyze: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createBusinessCycleService: () => service,
}));
const who = { spaceId: "space", userId: "owner", botId: "manager" };
const result = {
  evidenceIds: ["evidence"],
  summary: "Synthetic",
  disagreements: [],
  unresolved: [],
  improvementProposal: null,
};
async function invoke(args: Record<string, unknown>) {
  const finish = vi.fn(async (value: unknown) => value);
  const output = await tradingTools.business_cycle(
    { run: who, bot: { id: who.botId }, deps: { prisma: {} } } as never,
    { args, finish } as never,
  );
  return { output, finish };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of Object.values(service)) fn.mockResolvedValue({ saved: true });
  service.assign.mockImplementation(async (_who, input) => ({
    saved: true,
    input: BusinessAssignInputSchema.parse(input),
  }));
  service.analyze.mockImplementation(async (_who, input) => ({
    saved: true,
    input: z
      .strictObject({ cycleId: z.string(), deskId: z.string(), margin: z.string() })
      .parse(input),
  }));
});

describe("business_cycle command adaptation", () => {
  it.each([
    [{ operation: "list" }, "list", []],
    [{ operation: "read", cycleId: "cycle" }, "get", ["cycle"]],
    [
      { operation: "assign", cycleId: "cycle", requestId: "request", kind: "contract_coverage" },
      "assign",
      [{ cycleId: "cycle", requestId: "request", kind: "contract_coverage", dependsOn: [] }],
    ],
    [
      { operation: "analyze", cycleId: "cycle", deskId: "desk" },
      "analyze",
      [{ cycleId: "cycle", deskId: "desk", margin: "0" }],
    ],
    [{ operation: "settle", cycleId: "cycle" }, "settle", ["cycle"]],
    [
      { operation: "complete", ticketId: "ticket", result, expectedResultEvidenceId: null },
      "complete",
      ["ticket", result, null],
    ],
  ] as const)("adapts %j to the service's strict input", async (args, method, expected) => {
    const { output, finish } = await invoke(args);
    expect(output).toMatchObject({ saved: true });
    expect(service[method]).toHaveBeenCalledWith(who, ...expected);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("rejects unexpected command fields before service access, without claiming an unknown write", async () => {
    const { output, finish } = await invoke({
      operation: "assign",
      cycleId: "cycle",
      requestId: "request",
      kind: "contract_coverage",
      extra: "synthetic-private-value",
    });
    expect(output).toEqual({ error: "Business cycle request failed", code: "INVALID_INPUT" });
    expect(service.assign).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toContain("synthetic-private-value");
    expect(
      BusinessAssignInputSchema.safeParse({
        operation: "assign",
        cycleId: "cycle",
        requestId: "request",
        kind: "contract_coverage",
      }).success,
    ).toBe(false);
  });

  it("keeps service readback or infrastructure errors uncertain after a possible write", async () => {
    const invalid = BusinessCycleCommandSchema.safeParse({ operation: "invalid" });
    if (invalid.success) throw new Error("Expected invalid synthetic schema");
    for (const failure of [invalid.error, new Error("synthetic-private-database-error")]) {
      service.assign.mockRejectedValueOnce(failure);
      const { output, finish } = await invoke({
        operation: "assign",
        cycleId: "cycle",
        requestId: "request",
        kind: "contract_coverage",
      });
      expect(output).toMatchObject({ uncertain: true });
      expect(finish).not.toHaveBeenCalled();
      expect(JSON.stringify(output)).not.toContain("synthetic-private");
    }
  });

  it("retains known domain refusal codes and does not label read failures uncertain", async () => {
    service.assign.mockRejectedValueOnce(new TradingError("FORBIDDEN", "Synthetic refusal"));
    expect(
      (
        await invoke({
          operation: "assign",
          cycleId: "cycle",
          requestId: "request",
          kind: "contract_coverage",
        })
      ).output,
    ).toEqual({ error: "Synthetic refusal", code: "FORBIDDEN" });
    service.get.mockRejectedValueOnce(new Error("Synthetic unavailable"));
    expect((await invoke({ operation: "read", cycleId: "cycle" })).output).toEqual({
      error: "Business cycle request failed",
    });
  });
});

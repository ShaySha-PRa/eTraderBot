import type { TradingIntent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { tradingDecimal as d } from "./decimal.js";
import { simulateTradingExecution, tradingExecutionBalance } from "./execution.js";

const now = new Date("2026-11-03T00:00:00Z");
const intent: TradingIntent = {
  intentId: "synthetic-intent",
  intentHash: "a".repeat(64),
  scope: {
    subjectId: "synthetic",
    subjectKind: "retailer",
    accountId: "synthetic",
    region: "CN-SD",
    marketId: "synthetic",
    productId: "energy",
    stage: "day_ahead",
    environment: "simulation",
  },
  algorithmVersionId: "synthetic-v1",
  snapshotId: "synthetic-snapshot",
  ruleVersion: "synthetic-v1",
  expiresAt: "2026-11-03T01:00:00Z",
  lines: [
    {
      side: "buy",
      energyMwh: "0.03",
      limitPrice: "-0.000001",
      start: "2026-11-04T00:00:00Z",
      end: "2026-11-04T01:00:00Z",
    },
  ],
};
const input = {
  intent,
  executionId: "synthetic-execution",
  clientRequestId: "synthetic-request",
  scenario: "partial_fill" as const,
  energyStep: "0.01",
  now,
};
describe("synthetic execution accounting", () => {
  it("rounds cumulative fills once, preserves negative-price gross exposure and stable evidence", () => {
    const partial = simulateTradingExecution(input);
    expect(partial.fills[0]!.energyMwh).toBe("0.01");
    expect(tradingExecutionBalance(intent, partial)).toEqual({ settled: 1n, reserved: 0n });
    const full = simulateTradingExecution({ ...input, previous: partial, operation: "reconcile" });
    expect(full.fills[0]).toEqual(partial.fills[0]);
    expect(full.fills[1]!.energyMwh).toBe("0.02");
    expect(tradingExecutionBalance(intent, full)).toEqual({ settled: 1n, reserved: 0n });
    expect(new Set(full.fills.map((fill) => fill.fillId)).size).toBe(2);
  });
  it("never invents a sub-step partial fill for a one-quantum order", () => {
    const one = {
      ...intent,
      lines: intent.lines.map((line) => ({ ...line, energyMwh: "0.01", limitPrice: "300" })),
    };
    const pending = simulateTradingExecution({ ...input, intent: one });
    expect(pending.status).toBe("accepted");
    expect(pending.fills).toEqual([]);
    expect(tradingExecutionBalance(one, pending)).toEqual({ settled: 0n, reserved: d("3") });
  });
  it("unknown does not imply rejection or release", () => {
    const unknown = simulateTradingExecution({ ...input, scenario: "unavailable" });
    expect(tradingExecutionBalance(intent, unknown)).toEqual({ settled: 0n, reserved: 1n });
    const cancellation = simulateTradingExecution({
      ...input,
      scenario: "unavailable",
      previous: unknown,
      operation: "cancel",
    });
    expect(cancellation.status).toBe("unknown");
    expect(
      simulateTradingExecution({
        ...input,
        scenario: "unavailable",
        previous: cancellation,
        operation: "reconcile",
        cancellationPending: true,
      }),
    ).toBe(cancellation);
    expect(tradingExecutionBalance(intent, cancellation).reserved).toBe(1n);
  });
  it("rejects duplicated fills, overfills and false full-fill states", () => {
    const partial = simulateTradingExecution(input);
    expect(() =>
      tradingExecutionBalance(intent, { ...partial, fills: [...partial.fills, ...partial.fills] }),
    ).toThrow();
    expect(() =>
      tradingExecutionBalance(intent, {
        ...partial,
        fills: partial.fills.map((fill) => ({ ...fill, energyMwh: "1" })),
      }),
    ).toThrow();
    expect(() => tradingExecutionBalance(intent, { ...partial, status: "filled" })).toThrow();
  });
  it("terminal receipts cannot regress or lose filled quantities", () => {
    const partial = simulateTradingExecution(input);
    const cancelled = simulateTradingExecution({
      ...input,
      previous: partial,
      operation: "cancel",
    });
    expect(cancelled.fills).toEqual(partial.fills);
    expect(
      simulateTradingExecution({ ...input, previous: cancelled, operation: "reconcile" }),
    ).toBe(cancelled);
  });
});

import type { TradingScope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { runTradingBaseline, validateTradingSnapshot } from "./algorithms.js";
import { tradingDecimal as d, tradingDecimalString as s, tradingGrossNotional } from "./decimal.js";
import { createTradingSimulationSnapshot } from "./simulation.js";

const now = new Date("2026-11-03T00:00:00.000Z");
function fixture(kind: TradingScope["subjectKind"]) {
  return createTradingSimulationSnapshot(
    {
      subjectId: "subject-test",
      subjectKind: kind,
      accountId: "account-test",
      assetId: "asset-test",
      region: "CN-JS",
      marketId: "synthetic",
      productId: "energy",
      stage: "day_ahead",
      environment: "simulation",
    },
    now,
  );
}
const run = (snapshot: ReturnType<typeof fixture>) =>
  runTradingBaseline(snapshot, "baseline-v1", { margin: "0" }, now);

describe("trading decision contracts", () => {
  it("purchases the lowest-cost available offers and reports exactly covered exposure", () => {
    const result = run(fixture("retailer"));
    expect(
      result.lines.slice(0, 2).map(({ energyMwh, limitPrice }) => ({ energyMwh, limitPrice })),
    ).toEqual([
      { energyMwh: "3", limitPrice: "300" },
      { energyMwh: "1", limitPrice: "350" },
    ]);
    expect(result.grossNotionalCny).toBe("5000");
    expect(result.totalEnergyMwh).toBe("16");
    expect(result.uncoveredEnergyMwh).toBe("0");
  });
  it("sells surplus against the highest bids", () => {
    const snapshot = fixture("retailer");
    if (snapshot.input.kind !== "retailer") throw new Error("Fixture kind");
    snapshot.input.intervals[0]!.contractedEnergyMwh = "12";
    snapshot.input.intervals[0]!.saleOffers.push({
      offerId: "higher-bid",
      price: "320",
      availableEnergyMwh: "1",
    });
    expect(
      run(snapshot)
        .lines.slice(0, 2)
        .map((line) => [line.side, line.limitPrice, line.energyMwh]),
    ).toEqual([
      ["sell", "320", "1"],
      ["sell", "280", "1"],
    ]);
  });
  it("reports insufficient liquidity instead of fabricating a completed allocation", () => {
    const snapshot = fixture("retailer");
    if (snapshot.input.kind !== "retailer") throw new Error("Fixture kind");
    snapshot.input.intervals[0]!.purchaseOffers = [
      { offerId: "only", price: "300", availableEnergyMwh: "1" },
    ];
    expect(run(snapshot)).toMatchObject({
      uncoveredEnergyMwh: "3",
      warnings: ["UNFILLED_EXPOSURE"],
    });
  });
  it("reserves committed generation before offering profitable incremental capacity", () => {
    const result = run(fixture("generator"));
    expect(result.lines).toHaveLength(4);
    expect(
      result.lines.every(
        (line) => line.side === "sell" && line.energyMwh === "5" && line.limitPrice === "250",
      ),
    ).toBe(true);
    expect(result.totalEnergyMwh).toBe("20");
  });
  it("allows a genuine no-trade generation decision", () => {
    expect(
      runTradingBaseline(fixture("generator"), "expensive-v1", { margin: "1000" }, now).lines,
    ).toEqual([]);
  });
  it("charges at low prices and discharges at high prices with a physically valid terminal state", () => {
    const result = run(fixture("storage"));
    expect(result.lines.map((line) => line.side)).toEqual(["buy", "buy", "sell", "sell"]);
    expect(
      result.energyTrajectory.every(
        (point) => d(point.energyMwh) >= d("1") && d(point.energyMwh) <= d("9"),
      ),
    ).toBe(true);
    expect(d(result.energyTrajectory.at(-1)!.energyMwh)).toBeGreaterThanOrEqual(d("2"));
  });
  it("reports infeasible terminal reserves without outputting invalid trades", () => {
    const snapshot = fixture("storage");
    if (snapshot.input.kind !== "storage") throw new Error("Fixture kind");
    snapshot.input.terminalMinEnergyMwh = "9";
    snapshot.input.maxChargeMw = "0.01";
    expect(() => run(snapshot)).toThrow(
      expect.objectContaining({ code: "INFEASIBLE_TERMINAL_RESERVE" }),
    );
  });
  it.each(["retailer", "generator", "storage"] as const)(
    "replays the %s baseline from identical inputs",
    (kind) => {
      const snapshot = fixture(kind);
      const original = JSON.stringify(snapshot);
      expect(run(snapshot)).toEqual(run(structuredClone(snapshot)));
      expect(JSON.stringify(snapshot)).toBe(original);
    },
  );
  it("rejects stale snapshots", () => {
    expect(() =>
      validateTradingSnapshot(fixture("retailer"), new Date(now.getTime() + 3_600_000)),
    ).toThrow(expect.objectContaining({ code: "STALE_DATA" }));
  });
  it("rejects unknown payload fields that could smuggle approval state", () => {
    expect(() => validateTradingSnapshot({ ...fixture("retailer"), approved: true }, now)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
  it("rejects live requests backed by synthetic sources", () => {
    const snapshot = fixture("retailer");
    snapshot.scope.environment = "live";
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "ENVIRONMENT_MISMATCH" }));
  });
  it("allows sourced historical data in simulation without relabeling its provenance", () => {
    const snapshot = fixture("generator");
    snapshot.source.kind = "user";
    const result = run(snapshot);
    expect(result.scope.environment).toBe("simulation");
    expect(result.lines.length).toBeGreaterThan(0);
    expect(snapshot.source.kind).toBe("user");
  });
  it.each(["simulation", "live"] as const)("rejects unverified rules in %s", (environment) => {
    const snapshot = fixture("generator");
    snapshot.scope.environment = environment;
    snapshot.source.kind = "company";
    snapshot.rules.source.kind = "company";
    snapshot.rules.verification = "unverified";
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "RULES_UNVERIFIED" }));
  });
  it("rejects subject/input mismatch", () => {
    const snapshot = fixture("retailer");
    snapshot.scope.subjectKind = "generator";
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "SCOPE_MISMATCH" }));
  });
  it("rejects disordered and duplicated intervals", () => {
    const snapshot = fixture("retailer");
    snapshot.input.intervals[1]!.start = snapshot.input.intervals[0]!.start;
    snapshot.input.intervals[1]!.end = snapshot.input.intervals[0]!.end;
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("rejects a malformed storage efficiency", () => {
    const snapshot = fixture("storage");
    if (snapshot.input.kind !== "storage") throw new Error("Fixture kind");
    snapshot.input.chargeEfficiency = "1.1";
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("converts storage price estimates to conservative executable ticks", () => {
    const snapshot = fixture("storage");
    if (snapshot.input.kind !== "storage") throw new Error("Fixture kind");
    snapshot.input.intervals[0]!.forecastPrice = "100.001";
    snapshot.input.intervals[3]!.forecastPrice = "500.009";
    const result = run(snapshot);
    expect(result.lines[0]!.limitPrice).toBe("100");
    expect(result.lines.at(-1)!.limitPrice).toBe("500.01");
  });
  it("rejects off-tick executable market offers", () => {
    const snapshot = fixture("retailer");
    if (snapshot.input.kind !== "retailer") throw new Error("Fixture kind");
    snapshot.input.intervals[0]!.purchaseOffers[0]!.price = "300.001";
    expect(() => run(snapshot)).toThrow(expect.objectContaining({ code: "PRICE_STEP_MISMATCH" }));
  });
});

describe("trading fixed point arithmetic", () => {
  it.each(["0", "0.000001", "-0.000001", "100000000000", "-400.25"])("round trips %s", (value) =>
    expect(s(d(value))).toBe(value),
  );
  it.each(["1e4", "NaN", "Infinity", "01", "0.0000001"])("refuses ambiguous decimals %s", (value) =>
    expect(() => d(value)).toThrow(),
  );
  it("reserves gross exposure for negative prices and rounds up fractional micro-currency", () => {
    expect(tradingGrossNotional([{ energyMwh: "0.000001", limitPrice: "-0.000001" }])).toBe(
      "0.000001",
    );
  });
  it("does not lose integer precision on large products", () => {
    const result = tradingGrossNotional([
      { energyMwh: "999999999999", limitPrice: "999999999999" },
    ]);
    expect(result).toBe("999999999998000000000001");
    expect(s(d(result))).toBe(result);
  });
});

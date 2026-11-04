import type { TradingScope, TradingSnapshot } from "@rakazo/contracts";

/** Fixed synthetic values; only the requested clock/scope changes their envelope. */
export function createTradingSimulationSnapshot(scope: TradingScope, now: Date): TradingSnapshot {
  const base = new Date(now);
  base.setUTCHours(base.getUTCHours() + 1, 0, 0, 0);
  const intervals = [0, 1, 2, 3].map((hour) => ({
    start: new Date(base.getTime() + hour * 3_600_000).toISOString(),
    end: new Date(base.getTime() + (hour + 1) * 3_600_000).toISOString(),
  }));
  const source = {
    sourceId: "synthetic-fixture-v1",
    kind: "synthetic" as const,
    asOf: now.toISOString(),
    observedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
    revision: "1",
  };
  return {
    schemaVersion: "1",
    snapshotId: `demo-${scope.subjectKind}-${now.getTime()}`,
    scope,
    source,
    rules: {
      id: "synthetic-market",
      version: "synthetic-v1",
      source,
      verification: "synthetic",
      effectiveFrom: now.toISOString(),
      effectiveTo: new Date(base.getTime() + 86_400_000).toISOString(),
      timezone: "Asia/Shanghai",
      currency: "CNY",
      intervalMinutes: 60,
      priceMin: "-1000",
      priceMax: "10000",
      priceStep: "0.01",
      energyStep: "0.01",
      maxSnapshotAgeSeconds: 3600,
    },
    input:
      scope.subjectKind === "retailer"
        ? {
            kind: "retailer",
            intervals: intervals.map((period) => ({
              ...period,
              forecastDemandMwh: "10",
              contractedEnergyMwh: "6",
              purchaseOffers: [
                { offerId: "offer-a", price: "300", availableEnergyMwh: "3" },
                { offerId: "offer-b", price: "350", availableEnergyMwh: "5" },
              ],
              saleOffers: [{ offerId: "bid-a", price: "280", availableEnergyMwh: "10" }],
            })),
          }
        : scope.subjectKind === "generator"
          ? {
              kind: "generator",
              intervals: intervals.map((period) => ({
                ...period,
                availableEnergyMwh: "12",
                committedEnergyMwh: "2",
                forecastPrice: "400",
                segments: [
                  { segmentId: "base", energyMwh: "7", marginalCost: "250" },
                  { segmentId: "peak", energyMwh: "5", marginalCost: "450" },
                ],
              })),
            }
          : {
              kind: "storage",
              capacityMwh: "10",
              initialEnergyMwh: "2",
              minEnergyMwh: "1",
              maxEnergyMwh: "9",
              terminalMinEnergyMwh: "2",
              maxChargeMw: "4",
              maxDischargeMw: "4",
              chargeEfficiency: "0.9",
              dischargeEfficiency: "0.9",
              degradationCostPerMwh: "10",
              intervals: intervals.map((period, index) => ({
                ...period,
                forecastPrice: ["100", "150", "600", "500"][index]!,
              })),
            },
  };
}

import type { TradingOrderLine, TradingScope, TradingSnapshot } from "@rakazo/contracts";
import { TradingSnapshotSchema } from "@rakazo/contracts";
import {
  tradingAbs as abs,
  tradingCeil as ceil,
  tradingDecimal as d,
  tradingFloorStep as floorStep,
  tradingMax as max,
  tradingMin as min,
  tradingDecimalString as s,
  tradingScale as scale,
  tradingGrossNotional,
} from "./decimal.js";

export class TradingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TradingError";
  }
}
export function tradingAssert(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new TradingError(code, message);
}

export interface TradingAlgorithmParameters {
  /** Extra generation offer margin; extra spread required for storage arbitrage. */
  margin: string;
}
export interface TradingDecision {
  scope: TradingScope;
  snapshotId: string;
  algorithmVersionId: string;
  ruleVersion: string;
  lines: TradingOrderLine[];
  grossNotionalCny: string;
  totalEnergyMwh: string;
  uncoveredEnergyMwh: string;
  energyTrajectory: { end: string; energyMwh: string }[];
  warnings: string[];
}

export function validateTradingSnapshot(snapshot: unknown, now: Date): TradingSnapshot {
  const parsed = TradingSnapshotSchema.safeParse(snapshot);
  tradingAssert(parsed.success, "INVALID_INPUT", parsed.error?.message ?? "Invalid snapshot");
  const value = parsed.data;
  const { scope, source, rules, input } = value;
  tradingAssert(
    scope.subjectKind === input.kind,
    "SCOPE_MISMATCH",
    "Input kind does not match subject",
  );
  tradingAssert(Number.isFinite(now.getTime()), "INVALID_INPUT", "Invalid clock");
  for (const metadata of [source, rules.source]) {
    tradingAssert(
      Date.parse(metadata.asOf) <= Date.parse(metadata.observedAt) &&
        Date.parse(metadata.observedAt) < Date.parse(metadata.validUntil),
      "INVALID_INPUT",
      "Invalid source chronology",
    );
    tradingAssert(
      Date.parse(metadata.observedAt) <= now.getTime() &&
        Date.parse(metadata.validUntil) > now.getTime(),
      "STALE_DATA",
      "Source is not current",
    );
    tradingAssert(
      scope.environment !== "live" || metadata.kind !== "synthetic",
      "ENVIRONMENT_MISMATCH",
      "Live inputs cannot be synthetic",
    );
  }
  tradingAssert(
    now.getTime() - Date.parse(source.asOf) <= rules.maxSnapshotAgeSeconds * 1000,
    "STALE_DATA",
    "Snapshot exceeded allowed age",
  );
  tradingAssert(
    scope.environment === "live"
      ? rules.verification === "verified"
      : rules.verification === "synthetic" || rules.verification === "verified",
    "RULES_UNVERIFIED",
    "Rules are not verified for the environment",
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: rules.timezone });
  } catch {
    throw new TradingError("INVALID_INPUT", "Invalid rules timezone");
  }
  tradingAssert(d(rules.priceMin) <= d(rules.priceMax), "INVALID_INPUT", "Invalid price range");
  let previousEnd: number | undefined;
  for (const row of input.intervals) {
    const start = Date.parse(row.start),
      end = Date.parse(row.end);
    tradingAssert(
      end - start === rules.intervalMinutes * 60_000,
      "INVALID_INPUT",
      "Interval does not match rules",
    );
    tradingAssert(
      previousEnd === undefined || start === previousEnd,
      "INVALID_INPUT",
      "Intervals must be ordered and contiguous",
    );
    tradingAssert(
      start >= Date.parse(rules.effectiveFrom) && end <= Date.parse(rules.effectiveTo),
      "RULES_UNVERIFIED",
      "Rules do not cover interval",
    );
    previousEnd = end;
  }
  if (input.kind === "retailer") {
    for (const row of input.intervals) {
      for (const offers of [row.purchaseOffers, row.saleOffers]) {
        tradingAssert(
          new Set(offers.map((offer) => offer.offerId)).size === offers.length,
          "INVALID_INPUT",
          "Duplicate offer ID",
        );
      }
    }
  }
  if (input.kind === "generator") {
    for (const row of input.intervals) {
      tradingAssert(
        d(row.committedEnergyMwh) <= d(row.availableEnergyMwh),
        "INVALID_INPUT",
        "Generation commitments exceed capacity",
      );
      tradingAssert(
        row.segments.reduce((sum, segment) => sum + d(segment.energyMwh), 0n) >=
          d(row.availableEnergyMwh),
        "INVALID_INPUT",
        "Cost stack does not cover capacity",
      );
      tradingAssert(
        new Set(row.segments.map((segment) => segment.segmentId)).size === row.segments.length,
        "INVALID_INPUT",
        "Duplicate segment ID",
      );
    }
  }
  if (input.kind === "storage") {
    tradingAssert(scope.assetId, "INVALID_INPUT", "Storage requires an asset ID");
    tradingAssert(
      d(input.minEnergyMwh) <= d(input.initialEnergyMwh) &&
        d(input.initialEnergyMwh) <= d(input.maxEnergyMwh) &&
        d(input.maxEnergyMwh) <= d(input.capacityMwh) &&
        d(input.terminalMinEnergyMwh) >= d(input.minEnergyMwh) &&
        d(input.terminalMinEnergyMwh) <= d(input.maxEnergyMwh),
      "INVALID_INPUT",
      "Invalid storage bounds",
    );
    tradingAssert(
      d(input.chargeEfficiency) <= scale && d(input.dischargeEfficiency) <= scale,
      "INVALID_INPUT",
      "Efficiency must be at most one",
    );
  }
  return value;
}

/** Three explicit deterministic baselines, not paper reproductions or profit claims. */
export function runTradingBaseline(
  snapshot: TradingSnapshot,
  algorithmVersionId: string,
  parameters: TradingAlgorithmParameters,
  now: Date,
): TradingDecision {
  const { scope, rules, input } = validateTradingSnapshot(snapshot, now);
  const margin = d(parameters.margin);
  tradingAssert(margin >= 0n, "INVALID_INPUT", "Margin cannot be negative");
  const step = d(rules.energyStep),
    priceStep = d(rules.priceStep);
  const lines: TradingOrderLine[] = [];
  const energyTrajectory: TradingDecision["energyTrajectory"] = [];
  let uncovered = 0n;
  const warnings: string[] = [];
  function append(
    row: { start: string; end: string },
    side: "buy" | "sell",
    quantity: bigint,
    price: bigint,
    referenceId?: string,
  ) {
    const energy = floorStep(quantity, step);
    if (energy <= 0n) return 0n;
    tradingAssert(
      price >= d(rules.priceMin) && price <= d(rules.priceMax),
      "PRICE_OUT_OF_RANGE",
      "Candidate price outside rules",
    );
    tradingAssert(
      price % priceStep === 0n,
      "PRICE_STEP_MISMATCH",
      "Candidate price does not match price step",
    );
    lines.push({
      start: row.start,
      end: row.end,
      side,
      energyMwh: s(energy),
      limitPrice: s(price),
      ...(referenceId ? { referenceId } : {}),
    });
    return energy;
  }
  if (input.kind === "retailer") {
    for (const row of input.intervals) {
      const deficit = d(row.forecastDemandMwh) - d(row.contractedEnergyMwh);
      let remaining = abs(deficit);
      const side = deficit >= 0n ? "buy" : "sell";
      const offers = [...(side === "buy" ? row.purchaseOffers : row.saleOffers)].sort((a, b) => {
        const difference = d(a.price) - d(b.price);
        return difference === 0n
          ? a.offerId.localeCompare(b.offerId)
          : (difference < 0n ? -1 : 1) * (side === "buy" ? 1 : -1);
      });
      for (const offer of offers) {
        if (remaining <= 0n) break;
        remaining -= append(
          row,
          side,
          min(remaining, d(offer.availableEnergyMwh)),
          d(offer.price),
          offer.offerId,
        );
      }
      uncovered += remaining;
    }
  } else if (input.kind === "generator") {
    for (const row of input.intervals) {
      let committed = d(row.committedEnergyMwh);
      let available = d(row.availableEnergyMwh);
      const segments = [...row.segments].sort((a, b) =>
        d(a.marginalCost) < d(b.marginalCost)
          ? -1
          : d(a.marginalCost) > d(b.marginalCost)
            ? 1
            : a.segmentId.localeCompare(b.segmentId),
      );
      for (const segment of segments) {
        const capacity = min(available, d(segment.energyMwh));
        available -= capacity;
        const reserved = min(committed, capacity);
        committed -= reserved;
        const price = d(segment.marginalCost) + margin;
        // Round offers up, including negative prices, to preserve the requested margin.
        const quoted =
          price >= 0n ? ceil(price, priceStep) * priceStep : (price / priceStep) * priceStep;
        if (
          quoted <= d(row.forecastPrice) &&
          quoted >= d(rules.priceMin) &&
          quoted <= d(rules.priceMax)
        ) {
          append(row, "sell", capacity - reserved, quoted, segment.segmentId);
        }
      }
    }
  } else {
    // A transparent spread rule with a terminal reserve; every action is physically checked.
    const low = d(input.minEnergyMwh),
      high = d(input.maxEnergyMwh);
    const terminal = d(input.terminalMinEnergyMwh);
    const chargeEta = d(input.chargeEfficiency),
      dischargeEta = d(input.dischargeEfficiency);
    const chargeLimit = floorStep(
      (d(input.maxChargeMw) * BigInt(rules.intervalMinutes)) / 60n,
      step,
    );
    const dischargeLimit = floorStep(
      (d(input.maxDischargeMw) * BigInt(rules.intervalMinutes)) / 60n,
      step,
    );
    const mean =
      input.intervals.reduce((sum, row) => sum + d(row.forecastPrice), 0n) /
      BigInt(input.intervals.length);
    const cost = d(input.degradationCostPerMwh) + margin;
    let energy = d(input.initialEnergyMwh);
    for (let i = 0; i < input.intervals.length; i++) {
      const row = input.intervals[i]!;
      const price = d(row.forecastPrice);
      const futureCharge =
        ((chargeLimit * chargeEta) / scale) * BigInt(input.intervals.length - i - 1);
      const requiredNow = max(0n, terminal - futureCharge - energy);
      const affordableCharge = price + cost < (mean * chargeEta * dischargeEta) / scale / scale;
      const worthwhileSale = price - cost > (mean * scale * scale) / chargeEta / dischargeEta;
      // Forecasts are estimates, not executable quotes. Buy at a tick no higher than the
      // forecast and sell at a tick no lower, including markets with negative prices.
      const floorPrice =
        price >= 0n ? (price / priceStep) * priceStep : -ceil(-price, priceStep) * priceStep;
      const ceilPrice =
        price >= 0n ? ceil(price, priceStep) * priceStep : (price / priceStep) * priceStep;
      if (requiredNow > 0n || affordableCharge) {
        const room = floorStep(((high - energy) * scale) / chargeEta, step);
        const requiredGrid = ceil(ceil(requiredNow * scale, chargeEta), step) * step;
        const quantity = min(chargeLimit, room, affordableCharge ? chargeLimit : requiredGrid);
        const accepted = append(row, "buy", quantity, floorPrice);
        energy += (accepted * chargeEta) / scale;
      } else if (worthwhileSale) {
        const reserve = max(low, terminal - futureCharge);
        const quantity = min(dischargeLimit, (max(0n, energy - reserve) * dischargeEta) / scale);
        const accepted = append(row, "sell", quantity, ceilPrice);
        energy -= ceil(accepted * scale, dischargeEta);
      }
      tradingAssert(
        energy >= low && energy <= high,
        "ASSET_LIMIT_EXCEEDED",
        "Storage state violates capacity bounds",
      );
      energyTrajectory.push({ end: row.end, energyMwh: s(energy) });
    }
    tradingAssert(
      energy >= terminal,
      "INFEASIBLE_TERMINAL_RESERVE",
      "Terminal reserve cannot be met at the configured power and energy step",
    );
  }
  if (uncovered > 0n) warnings.push("UNFILLED_EXPOSURE");
  return {
    scope,
    snapshotId: snapshot.snapshotId,
    algorithmVersionId,
    ruleVersion: rules.version,
    lines,
    grossNotionalCny: tradingGrossNotional(lines),
    totalEnergyMwh: s(lines.reduce((sum, line) => sum + d(line.energyMwh), 0n)),
    uncoveredEnergyMwh: s(uncovered),
    energyTrajectory,
    warnings,
  };
}

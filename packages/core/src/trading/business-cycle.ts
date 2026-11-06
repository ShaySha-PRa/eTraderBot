import type {
  BusinessEvidence,
  BusinessMarketRule,
  BusinessSettlement,
  BusinessWorkKind,
} from "@rakazo/contracts";
import { BusinessImportDataSchema } from "@rakazo/contracts";
import { tradingAssert } from "./algorithms.js";
import {
  tradingDecimal as d,
  tradingDecimalString as s,
  tradingScale as scale,
} from "./decimal.js";

export const businessWorkRequirements: Record<
  BusinessWorkKind,
  { role: "mid_long_term" | "spot" | "risk" | "review"; evidence: string[] }
> = {
  contract_coverage: { role: "mid_long_term", evidence: ["contracts"] },
  spot_analysis: { role: "spot", evidence: ["contracts", "forecast", "asset"] },
  risk_check: { role: "risk", evidence: ["contracts", "forecast", "asset"] },
  settlement_review: {
    role: "review",
    evidence: [
      "contracts",
      "submission",
      "clearing:day_ahead",
      "clearing:realtime",
      "delivery",
      "metering",
      "bill",
      "settlement",
    ],
  },
};

/** Review produces its settlement; completion still requires every confirmed final input. */
export function businessWorkStartEvidence(kind: BusinessWorkKind) {
  const evidence = businessWorkRequirements[kind].evidence;
  return kind === "settlement_review" ? evidence.filter((key) => key !== "settlement") : evidence;
}

export function latestBusinessEvidence(rows: BusinessEvidence[]) {
  const streams = new Map<string, BusinessEvidence>();
  for (const row of rows) {
    // Legacy receipts share one physical stream. Classify them on read without rewriting history.
    const key =
      row.kind === "submission" && typeof row.data.stage === "string"
        ? businessSubmissionStream(row.data.stage)
        : row.streamKey;
    const prior = streams.get(key);
    if (
      !prior ||
      (row.streamKey === key && prior.streamKey !== key) ||
      ((row.streamKey === key) === (prior.streamKey === key) && row.revision > prior.revision)
    )
      streams.set(key, row);
  }
  return [...streams].map(([key, row]) =>
    row.streamKey === key ? row : { ...row, streamKey: key },
  );
}

/** Keep the existing day-ahead key for consumers; other phases have independent streams. */
export const businessSubmissionStream = (stage: string) =>
  stage === "day_ahead" ? "submission" : `submission:${stage}`;

/** A correction invalidates every derived record that still refers to the old version. */
export function currentBusinessEvidence(rows: BusinessEvidence[]) {
  const latest = latestBusinessEvidence(rows);
  const ids = new Set(latest.map((row) => row.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of latest) {
      if (
        ["bill", "settlement", "review"].includes(row.kind) &&
        ids.has(row.id) &&
        row.references.some((id) => !ids.has(id))
      ) {
        ids.delete(row.id);
        changed = true;
      }
    }
  }
  return latest.filter((row) => ids.has(row.id));
}

export function businessEvidenceBlockers(
  rows: BusinessEvidence[],
  required: string[],
  confirmed = false,
) {
  const current = currentBusinessEvidence(rows);
  return required.filter(
    (key) =>
      !current.some(
        (row) =>
          row.streamKey === key &&
          (!confirmed || row.status === "confirmed") &&
          (row.kind !== "clearing" || row.data.result === "final") &&
          (row.kind !== "submission" ||
            ["accepted", "partially_filled", "filled"].includes(String(row.data.status))),
      ),
  );
}

/** P25 teaching assumptions only. Fixed-point operations keep both algebraic forms identical. */
export function calculateBusinessSettlement(
  rows: BusinessEvidence[],
  rule: BusinessMarketRule,
): BusinessSettlement {
  const current = currentBusinessEvidence(rows);
  function read<K extends "contracts" | "clearing" | "metering" | "bill">(key: string, kind: K) {
    const row = current.find((r) => r.streamKey === key);
    tradingAssert(row, "MISSING_EVIDENCE", `Missing current evidence: ${key}`);
    const data = BusinessImportDataSchema.parse(row.data);
    tradingAssert(data.kind === kind, "INVALID_INPUT", `Invalid ${key} evidence`);
    return { row, data: data as Extract<typeof data, { kind: K }> };
  }
  const contract = read("contracts", "contracts"),
    day = read("clearing:day_ahead", "clearing"),
    real = read("clearing:realtime", "clearing"),
    meter = read("metering", "metering");
  tradingAssert(
    day.data.result === "final" && real.data.result === "final",
    "MISSING_EVIDENCE",
    "Final simulated clearing results required",
  );
  const key = (r: { start: string; end: string }) => `${r.start}/${r.end}`;
  const lines = meter.data.intervals.map((actual) => {
    const contracts = contract.data.intervals.filter((c) => key(c) === key(actual));
    const da = day.data.intervals.find((r) => key(r) === key(actual));
    const rt = real.data.intervals.find((r) => key(r) === key(actual));
    tradingAssert(
      contracts.length && da && rt,
      "MISSING_EVIDENCE",
      "Unmatched contract, clearing or metering interval",
    );
    tradingAssert(
      [...contracts, da, rt].every((r) => r.referencePoint === rule.referencePoint),
      "REFERENCE_MISMATCH",
      "Teaching settlement requires one declared reference point",
    );
    const qc = contracts.reduce((n, c) => n + d(c.energyMwh), 0n),
      qd = d(da.energyMwh),
      qa = d(actual.energyMwh),
      pd = d(da.price),
      pr = d(rt.price);
    const contractRaw = contracts.reduce((n, c) => n + d(c.energyMwh) * d(c.price), 0n);
    const daRaw = (qd - qc) * pd,
      rtRaw = (qa - qd) * pr;
    const equivalentRaw =
      qa * pr +
      qd * (pd - pr) +
      contracts.reduce((n, c) => n + d(c.energyMwh) * (d(c.price) - pd), 0n);
    return {
      start: actual.start,
      end: actual.end,
      contractMwh: s(qc),
      dayAheadMwh: s(qd),
      actualMwh: s(qa),
      dayAheadDeviationMwh: s(qd - qc),
      realtimeDeviationMwh: s(qa - qd),
      contractCny: s(contractRaw / scale),
      dayAheadDeviationCny: s(daRaw / scale),
      realtimeDeviationCny: s(rtRaw / scale),
      energyAmountCny: s((contractRaw + daRaw + rtRaw) / scale),
      equivalentDifferenceCny: s(equivalentRaw / scale),
    };
  });
  const sum = (field: "energyAmountCny" | "equivalentDifferenceCny") =>
    s(lines.reduce((n, l) => n + d(l[field]), 0n));
  const billRow = current.find((r) => r.streamKey === "bill");
  const bill = billRow ? read("bill", "bill").data : null;
  return {
    method: "teaching_double_deviation",
    ruleVersion: rule.version,
    lines,
    energyAmountCny: sum("energyAmountCny"),
    equivalentDifferenceCny: sum("equivalentDifferenceCny"),
    billedEnergyAmountCny: bill?.energyAmountCny ?? null,
    billDifferenceCny: bill ? s(d(sum("energyAmountCny")) - d(bill.energyAmountCny)) : null,
    costsCny: bill?.costsCny ?? null,
    otherFeesCny: bill?.otherFeesCny ?? null,
    netProfitCny: null,
    missing: [
      ...(!bill ? ["bill"] : []),
      ...(bill?.costsCny == null ? ["costs"] : []),
      ...(bill?.otherFeesCny == null ? ["other_fees"] : []),
    ],
  };
}

import type { BusinessEvidence, BusinessMarketRule } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  businessEvidenceBlockers,
  calculateBusinessSettlement,
  currentBusinessEvidence,
  latestBusinessEvidence,
} from "./business-cycle.js";

const period = { start: "2030-05-02T00:00:00.000Z", end: "2030-05-02T01:00:00.000Z" };
const rule: BusinessMarketRule = {
  version: "P25-synthetic-v1",
  source: "synthetic-teaching-P25",
  settlementMethod: "teaching_double_deviation",
  referencePoint: "synthetic-reference",
  subjectKinds: ["generator"],
  stages: [],
};
function row(
  streamKey: string,
  data: Record<string, unknown>,
  refs: string[] = [],
): BusinessEvidence {
  return {
    id: streamKey,
    cycleId: "synthetic",
    streamKey,
    revision: 1,
    supersedesId: null,
    kind: streamKey.startsWith("clearing") ? "clearing" : (streamKey as BusinessEvidence["kind"]),
    status: "confirmed",
    origin: "synthetic",
    source: "P25 fixture",
    sourceRecordId: streamKey,
    receivedAt: period.start,
    references: refs,
    data,
    contentHash: "synthetic-hash",
    recordedByUserId: "synthetic-user",
    recordedByBotId: null,
  };
}
const fixture = () => [
  row("contracts", {
    kind: "contracts",
    intervals: [
      {
        ...period,
        energyMwh: "100",
        price: "300",
        referencePoint: rule.referencePoint,
        attribute: "financial",
      },
    ],
  }),
  row("clearing:day_ahead", {
    kind: "clearing",
    stage: "day_ahead",
    result: "final",
    intervals: [{ ...period, energyMwh: "90", price: "320", referencePoint: rule.referencePoint }],
  }),
  row("clearing:realtime", {
    kind: "clearing",
    stage: "realtime",
    result: "final",
    intervals: [{ ...period, energyMwh: "80", price: "310", referencePoint: rule.referencePoint }],
  }),
  row("metering", {
    kind: "metering",
    meterId: "synthetic",
    intervals: [{ ...period, energyMwh: "80" }],
  }),
];
describe("teaching business settlement", () => {
  it("matches both P25 forms without inventing costs, bills or net profit", () => {
    const result = calculateBusinessSettlement(fixture(), rule);
    expect(result).toMatchObject({
      energyAmountCny: "23700",
      equivalentDifferenceCny: "23700",
      netProfitCny: null,
      billedEnergyAmountCny: null,
      missing: ["bill", "costs", "other_fees"],
    });
    expect(result.lines[0]).toMatchObject({
      dayAheadDeviationMwh: "-10",
      realtimeDeviationMwh: "-10",
      contractCny: "30000",
      dayAheadDeviationCny: "-3200",
      realtimeDeviationCny: "-3100",
    });
  });
  it("supports multiple financial/physical contracts and negative prices without double counting", () => {
    const rows = fixture();
    rows[0]!.data = {
      kind: "contracts",
      intervals: [
        {
          ...period,
          energyMwh: "50",
          price: "-10.25",
          attribute: "financial",
          referencePoint: rule.referencePoint,
        },
        {
          ...period,
          energyMwh: "50",
          price: "300.25",
          attribute: "physical",
          referencePoint: rule.referencePoint,
        },
      ],
    };
    const result = calculateBusinessSettlement(rows, rule);
    expect(result.energyAmountCny).toBe("8200");
    expect(result.equivalentDifferenceCny).toBe("8200");
    expect(result.lines[0]?.contractMwh).toBe("100");
  });
  it("refuses missing metering and unmapped reference points", () => {
    expect(() => calculateBusinessSettlement(fixture().slice(0, 3), rule)).toThrow("metering");
    expect(() =>
      calculateBusinessSettlement(fixture(), { ...rule, referencePoint: "another" }),
    ).toThrow("reference point");
  });
  it("keeps historic source relationships while invalidating derived settlement and review after correction", () => {
    const rows = fixture();
    rows.push(row("settlement", {}, ["metering"]), row("review", {}, ["settlement"]));
    rows.push({ ...rows[3]!, id: "meter-v2", revision: 2, supersedesId: "metering" });
    expect(currentBusinessEvidence(rows).map((r) => r.id)).toEqual([
      "contracts",
      "clearing:day_ahead",
      "clearing:realtime",
      "meter-v2",
    ]);
    expect(businessEvidenceBlockers(rows, ["metering", "settlement"], true)).toEqual([
      "settlement",
    ]);
    rows[rows.length - 1]!.status = "estimated";
    expect(businessEvidenceBlockers(rows, ["metering"], true)).toEqual(["metering"]);
  });
});

it("classifies legacy mixed submission history by stage without changing archived rows", () => {
  const mid = {
    ...row("submission", { stage: "mid_long_term", status: "accepted" }),
    id: "mid",
    revision: 1,
  };
  const day = {
    ...row("submission", { stage: "day_ahead", status: "accepted" }),
    id: "day",
    revision: 2,
    supersedesId: mid.id,
  };
  const oldReceiptUpdate = { ...mid, id: "mid-receipt", revision: 3, supersedesId: day.id };
  const history = [mid, day, oldReceiptUpdate];
  expect(latestBusinessEvidence(history).map((e) => [e.streamKey, e.id])).toEqual([
    ["submission:mid_long_term", "mid-receipt"],
    ["submission", "day"],
  ]);
  const migratedReceipt = {
    ...mid,
    id: "mid-new",
    streamKey: "submission:mid_long_term",
    revision: 1,
  };
  expect(
    latestBusinessEvidence([...history, migratedReceipt]).find(
      (e) => e.streamKey === "submission:mid_long_term",
    )?.id,
  ).toBe("mid-new");
  expect(history.map((e) => e.streamKey)).toEqual(["submission", "submission", "submission"]);
});

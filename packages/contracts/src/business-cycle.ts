import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  TradingDecimalSchema as decimal,
  TradingUnsignedDecimalSchema as energy,
  TradingScopeSchema,
} from "./trading.js";
import { TradingAnalysisSchema } from "./trading-rpc.js";

const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
const period = { start: instant, end: instant };
const quantity = z.strictObject({ ...period, energyMwh: energy });
const priced = quantity.extend({ price: decimal, referencePoint: id });
export const BusinessEvidenceKindSchema = z.enum([
  "contracts",
  "forecast",
  "asset",
  "submission",
  "clearing",
  "delivery",
  "metering",
  "bill",
  "settlement",
  "review",
]);
export const BusinessMarketRuleSchema = z.strictObject({
  version: id,
  source: z.literal("synthetic-teaching-P25"),
  settlementMethod: z.literal("teaching_double_deviation"),
  referencePoint: id,
  subjectKinds: z.array(TradingScopeSchema.shape.subjectKind).min(1),
  stages: z
    .array(
      z.strictObject({
        stage: TradingScopeSchema.shape.stage,
        mode: z.enum(["quantity_price", "results_only", "closed"]),
        opensAt: instant,
        closesAt: instant,
        allowRevision: z.boolean(),
        allowCancellation: z.boolean(),
        requires: z.array(BusinessEvidenceKindSchema).max(10),
      }),
    )
    .min(1)
    .max(4),
});
export const BusinessImportDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contracts"),
    intervals: z
      .array(priced.extend({ attribute: z.enum(["financial", "physical"]) }))
      .min(1)
      .max(672),
  }),
  z.strictObject({
    kind: z.literal("forecast"),
    intervals: z
      .array(quantity.extend({ price: decimal }))
      .min(1)
      .max(672),
  }),
  z.strictObject({
    kind: z.literal("asset"),
    intervals: z
      .array(
        z.strictObject({
          ...period,
          availableEnergyMwh: energy,
          otherPhysicalCommitmentMwh: energy,
          marginalCost: decimal,
        }),
      )
      .min(1)
      .max(672),
  }),
  z.strictObject({
    kind: z.literal("clearing"),
    stage: z.enum(["day_ahead", "realtime"]),
    result: z.enum(["preliminary", "final"]),
    intervals: z.array(priced).min(1).max(672),
  }),
  z.strictObject({ kind: z.literal("delivery"), intervals: z.array(quantity).min(1).max(672) }),
  z.strictObject({
    kind: z.literal("metering"),
    meterId: id,
    intervals: z.array(quantity).min(1).max(672),
  }),
  z.strictObject({
    kind: z.literal("bill"),
    energyAmountCny: decimal,
    costsCny: energy.nullable(),
    otherFeesCny: decimal.nullable(),
  }),
]);
export const BusinessSettlementSchema = z.object({
  method: z.literal("teaching_double_deviation"),
  ruleVersion: id,
  lines: z.array(
    z.object({
      ...period,
      contractMwh: decimal,
      dayAheadMwh: decimal,
      actualMwh: decimal,
      dayAheadDeviationMwh: decimal,
      realtimeDeviationMwh: decimal,
      contractCny: decimal,
      dayAheadDeviationCny: decimal,
      realtimeDeviationCny: decimal,
      energyAmountCny: decimal,
      equivalentDifferenceCny: decimal,
    }),
  ),
  energyAmountCny: decimal,
  equivalentDifferenceCny: decimal,
  billedEnergyAmountCny: decimal.nullable(),
  billDifferenceCny: decimal.nullable(),
  costsCny: decimal.nullable(),
  otherFeesCny: decimal.nullable(),
  netProfitCny: z.null(),
  missing: z.array(z.string()),
});
export const BusinessEvidenceSchema = z.object({
  id,
  cycleId: id,
  streamKey: id,
  revision: z.number().int().positive(),
  supersedesId: id.nullable(),
  kind: BusinessEvidenceKindSchema,
  status: z.enum(["estimated", "confirmed"]),
  origin: z.enum(["synthetic", "internal_trial", "external_official"]),
  source: z.string(),
  sourceRecordId: id,
  receivedAt: instant,
  recordedByUserId: id,
  recordedByBotId: id.nullable(),
  references: z.array(id),
  data: z.record(z.string(), z.unknown()),
  contentHash: id,
});
export const BusinessWorkKindSchema = z.enum([
  "contract_coverage",
  "spot_analysis",
  "risk_check",
  "settlement_review",
]);
export const BusinessWorkResultSchema = z.strictObject({
  evidenceIds: z.array(id).min(1).max(100),
  summary: z.string().min(1).max(8000),
  disagreements: z.array(z.string().max(2000)).max(20),
  unresolved: z.array(z.string().max(2000)).max(20),
  improvementProposal: z.string().max(8000).nullable(),
});
export const BusinessWorkSchema = z.object({
  ticketId: id,
  ref: z.string(),
  kind: BusinessWorkKindSchema,
  assigneeBotId: id.nullable(),
  status: z.string(),
  dependsOn: z.array(id),
  requiredEvidence: z.array(z.string()),
  blockers: z.array(z.string()),
  startBlockers: z.array(z.string()).optional(),
  result: BusinessWorkResultSchema.nullable(),
});
export const BusinessCycleSchema = z.object({
  id,
  workspaceId: id,
  name: z.string(),
  start: instant,
  end: instant,
  rule: BusinessMarketRuleSchema,
  createdAt: instant,
});
export const BusinessCycleStateSchema = z.object({
  cycle: BusinessCycleSchema,
  evidence: z.array(BusinessEvidenceSchema),
  tasks: z.array(BusinessWorkSchema),
  settlement: BusinessSettlementSchema.nullable(),
  reviewReady: z.boolean(),
  blockers: z.array(z.string()),
});
export const BusinessImportInputSchema = z.strictObject({
  cycleId: id,
  source: id,
  sourceRecordId: id,
  supersedesId: id.optional(),
  status: z.enum(["estimated", "confirmed"]),
  references: z.array(id).max(100).default([]),
  data: BusinessImportDataSchema,
});
export const BusinessAssignInputSchema = z.strictObject({
  cycleId: id,
  requestId: id,
  kind: BusinessWorkKindSchema,
  dependsOn: z.array(id).max(20).default([]),
});
export const businessCycleContract = {
  list: oc.input(z.strictObject({})).output(z.array(BusinessCycleSchema)),
  get: oc.input(z.strictObject({ cycleId: id })).output(BusinessCycleStateSchema),
  createDemo: oc.input(z.strictObject({ requestId: id })).output(BusinessCycleStateSchema),
  importEvidence: oc.input(BusinessImportInputSchema).output(BusinessEvidenceSchema),
  demoResults: oc
    .input(z.strictObject({ cycleId: id, executionId: id }))
    .output(BusinessCycleStateSchema),
  demoMetering: oc
    .input(
      z.strictObject({
        cycleId: id,
        energyMwh: energy.default("80"),
        status: z.enum(["estimated", "confirmed"]).default("confirmed"),
        supersedesId: id.optional(),
        requestId: id,
      }),
    )
    .output(BusinessCycleStateSchema),
  analyze: oc
    .input(z.strictObject({ cycleId: id, deskId: id, margin: energy.default("0") }))
    .output(TradingAnalysisSchema),
  settle: oc.input(z.strictObject({ cycleId: id })).output(BusinessCycleStateSchema),
  assign: oc.input(BusinessAssignInputSchema).output(BusinessCycleStateSchema),
  complete: oc
    .input(z.strictObject({ ticketId: id, result: BusinessWorkResultSchema }))
    .output(BusinessCycleStateSchema),
};
export const BusinessCycleCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("read"), cycleId: id }),
  BusinessAssignInputSchema.extend({ operation: z.literal("assign") }),
  z.strictObject({
    operation: z.literal("analyze"),
    cycleId: id,
    deskId: id,
    margin: energy.default("0"),
  }),
  z.strictObject({ operation: z.literal("settle"), cycleId: id }),
  z.strictObject({
    operation: z.literal("complete"),
    ticketId: id,
    result: BusinessWorkResultSchema,
  }),
]);
export type BusinessMarketRule = z.infer<typeof BusinessMarketRuleSchema>;
export type BusinessImportInput = z.infer<typeof BusinessImportInputSchema>;
export type BusinessEvidence = z.infer<typeof BusinessEvidenceSchema>;
export type BusinessSettlement = z.infer<typeof BusinessSettlementSchema>;
export type BusinessWorkResult = z.infer<typeof BusinessWorkResultSchema>;
export type BusinessWorkKind = z.infer<typeof BusinessWorkKindSchema>;
export type BusinessCycleState = z.infer<typeof BusinessCycleStateSchema>;

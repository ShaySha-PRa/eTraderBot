import type { InferContractRouterInputs } from "@orpc/contract";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { TradingUnsignedDecimalSchema } from "./trading.js";

const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TRADING_LEARNING_VALIDATOR_VERSION = "constraints-temporal-hidden-holdout-v2";
export const TradingLearningScheduleSchema = z.strictObject({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  active: z.boolean(),
});
export const TradingLearningSourceSchema = z.strictObject({
  id,
  deskId: id,
  kind: z.enum(["chat", "file", "operation", "history"]),
  reference: z.string(),
  content: z.string(),
  contentHash: hash,
  createdAt: instant,
});
export const TradingLearningProposalSchema = z.strictObject({
  sessionId: id,
  hypothesis: z.string().min(1).max(8000),
  experience: z.string().min(1).max(16000),
  sourceIds: z.array(id).min(1).max(100),
  candidateMargin: TradingUnsignedDecimalSchema,
});
const comparison = z.strictObject({
  sourceId: id,
  partition: z.enum(["train", "holdout"]),
  baselineGrossCny: z.string(),
  candidateGrossCny: z.string(),
  baselineUncoveredMwh: z.string(),
  candidateUncoveredMwh: z.string(),
  constraintsPassed: z.boolean(),
  error: z.string().nullable(),
});
export const TradingLearningReportSchema = z.strictObject({
  validatorVersion: z.literal(TRADING_LEARNING_VALIDATOR_VERSION),
  id,
  deskId: id,
  sessionId: id,
  createdAt: instant,
  inputHash: hash,
  engineHash: hash,
  sourceIds: z.array(id),
  citedSourceIds: z.array(id),
  hypothesis: z.string(),
  experience: z.string(),
  outcome: z.enum(["proposal", "no_new_data", "no_data"]),
  baselineMargin: TradingUnsignedDecimalSchema,
  candidateMargin: TradingUnsignedDecimalSchema,
  validation: z.enum(["insufficient_data", "constraints_failed", "constraints_passed"]),
  semanticEvaluation: z.literal("not_evaluated"),
  performanceConclusion: z.literal("not_established"),
  comparisons: z.array(comparison),
  versionId: id.nullable(),
});
export const TradingLearningPlanSchema = z.strictObject({
  id,
  deskId: id,
  botId: id,
  routineId: id,
  schedule: TradingLearningScheduleSchema,
  nextRunAt: instant.nullable(),
  baselineMargin: TradingUnsignedDecimalSchema,
});
export const tradingLearningContract = {
  learningState: oc.input(z.strictObject({ deskId: id })).output(
    z.strictObject({
      plans: z.array(TradingLearningPlanSchema),
      sources: z.array(TradingLearningSourceSchema),
      reports: z.array(TradingLearningReportSchema),
      sessions: z.array(
        z.strictObject({
          id: id.nullable(),
          botId: id,
          runId: id,
          createdAt: instant,
          inputHash: hash.nullable(),
          runStatus: z.string(),
          error: z.string().nullable(),
          reportId: id.nullable(),
        }),
      ),
    }),
  ),
  configureLearning: oc
    .input(
      z.strictObject({
        deskId: id,
        botId: id,
        schedule: TradingLearningScheduleSchema,
        baselineMargin: TradingUnsignedDecimalSchema.default("0"),
      }),
    )
    .output(TradingLearningPlanSchema),
  addLearningSource: oc
    .input(
      z.strictObject({
        deskId: id,
        kind: z.enum(["chat", "file"]),
        reference: z.string().min(1).max(500),
        content: z.string().min(1).max(64000),
      }),
    )
    .output(TradingLearningSourceSchema),
  captureLearningMessage: oc
    .input(z.strictObject({ deskId: id, botId: id, messageId: id }))
    .output(TradingLearningSourceSchema),
  startLearning: oc
    .input(z.strictObject({ deskId: id, botId: id, clientRequestId: id }))
    .output(z.strictObject({ runId: id, reused: z.boolean() })),
  shareLearningExperience: oc
    .input(z.strictObject({ deskId: id, reportId: id, targetDeskId: id }))
    .output(TradingLearningSourceSchema),
};
export type TradingLearningInputs = InferContractRouterInputs<typeof tradingLearningContract>;
export type TradingLearningReport = z.infer<typeof TradingLearningReportSchema>;
export type TradingLearningSource = z.infer<typeof TradingLearningSourceSchema>;

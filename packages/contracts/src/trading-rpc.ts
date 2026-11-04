import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  TradingOrderLineSchema,
  TradingScopeSchema,
  TradingSnapshotSchema,
  TradingUnsignedDecimalSchema,
} from "./trading.js";
import { tradingControlContract } from "./trading-control.js";
import { tradingLearningContract } from "./trading-learning.js";
import { tradingWeatherContract } from "./trading-weather.js";
import { tradingWorkspaceContract } from "./trading-workspace.js";

const amount = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,6})?$/);
export const TradingDecisionSchema = z.strictObject({
  scope: TradingScopeSchema,
  snapshotId: z.string(),
  algorithmVersionId: z.string(),
  ruleVersion: z.string(),
  lines: z.array(TradingOrderLineSchema),
  grossNotionalCny: amount,
  totalEnergyMwh: amount,
  uncoveredEnergyMwh: amount,
  energyTrajectory: z.array(z.strictObject({ end: z.string(), energyMwh: amount })),
  warnings: z.array(z.string()),
});
export const TradingAnalysisSchema = z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  snapshot: TradingSnapshotSchema,
  decision: TradingDecisionSchema,
  parameters: z.strictObject({ margin: TradingUnsignedDecimalSchema }),
});
export const TradingSimulationInputSchema = z.strictObject({
  scope: TradingScopeSchema.extend({ environment: z.literal("simulation") }),
  parameters: z.strictObject({ margin: TradingUnsignedDecimalSchema }).default({ margin: "0" }),
});
export const tradingContract = {
  ...tradingControlContract,
  ...tradingLearningContract,
  ...tradingWorkspaceContract,
  ...tradingWeatherContract,
  simulate: oc.input(TradingSimulationInputSchema).output(TradingAnalysisSchema),
  get: oc.input(z.strictObject({ id: z.string().min(1) })).output(TradingAnalysisSchema),
  replay: oc.input(z.strictObject({ id: z.string().min(1) })).output(
    z.strictObject({
      analysisId: z.string(),
      matchesRecordedDecision: z.boolean(),
      decision: TradingDecisionSchema,
    }),
  ),
  history: oc
    .input(z.strictObject({ limit: z.number().int().min(1).max(100).default(20) }))
    .output(z.array(TradingAnalysisSchema)),
};
export type TradingAnalysis = z.infer<typeof TradingAnalysisSchema>;

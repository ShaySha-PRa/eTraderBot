import type { InferContractRouterInputs } from "@orpc/contract";
import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  TradingIntentSchema,
  TradingReceiptSchema,
  TradingScopeSchema,
  TradingSnapshotSchema,
  TradingUnsignedDecimalSchema,
} from "./trading.js";
import { TradingBotRoleSchema } from "./trading-bot-template.js";
import {
  TradingLearningProposalSchema,
  TradingLearningScheduleSchema,
} from "./trading-learning.js";

const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,6})?$/);
const parameters = z.strictObject({ margin: TradingUnsignedDecimalSchema });
export const TradingDeskSchema = z.strictObject({
  id,
  spaceId: id,
  ownerUserId: id,
  algorithmApproverUserId: id,
  tradeApproverUserId: id,
  scope: TradingScopeSchema.extend({ environment: z.literal("simulation") }),
  createdAt: instant,
});
export const TradingVersionSchema = z.strictObject({
  id,
  deskId: id,
  algorithmVersionId: id,
  artifactHash: hash,
  artifact: z.string(),
  parameters,
  validation: z.union([
    z.strictObject({
      kind: z.literal("deterministic_constraints"),
      analysisId: id,
      decisionHash: hash,
    }),
    z.strictObject({ kind: z.literal("learning_constraints"), reportId: id, inputHash: hash }),
  ]),
  status: z.enum(["pending", "approved", "retired"]),
  approvedByUserId: id.nullable(),
  approvedAt: instant.nullable(),
  createdAt: instant,
});
export const TradingStoredIntentSchema = z.strictObject({
  botId: id.nullable(),
  id,
  deskId: id,
  versionId: id,
  analysisId: id,
  intent: TradingIntentSchema,
  snapshot: TradingSnapshotSchema,
  parameters,
  grossNotionalCny: money,
  approvedByUserId: id.nullable(),
  approvedAt: instant.nullable(),
  createdAt: instant,
});
export const TradingGrantSchema = z.strictObject({
  botId: id.nullable(),
  id,
  deskId: id,
  versionId: id,
  perTradeLimitCny: money,
  cumulativeLimitCny: money,
  usedCny: money,
  reservedCny: money.default("0"),
  allowCancellation: z.boolean().default(false),
  expiresAt: instant,
  revokedAt: instant.nullable(),
  approvedByUserId: id,
  createdAt: instant,
});
export const TradingExecutionSchema = z.strictObject({
  id,
  deskId: id,
  intentId: id,
  grantId: id.nullable(),
  clientRequestId: id,
  receipt: TradingReceiptSchema,
  receipts: z.array(TradingReceiptSchema).default([]),
  createdAt: instant,
});
export const TradingAuditSchema = z.strictObject({
  id,
  deskId: id,
  actorUserId: id,
  kind: z.string(),
  recordId: id,
  createdAt: instant,
});
export const TradingSimulationScenarioSchema = z.enum([
  "immediate_fill",
  "partial_fill",
  "timeout",
  "rejected",
  "pending",
  "cancel_timeout",
  "unavailable",
]);
export type TradingSimulationScenario = z.infer<typeof TradingSimulationScenarioSchema>;
const deskId = z.strictObject({ deskId: id });

export { TradingBotRoleSchema } from "./trading-bot-template.js";
export const TradingBotBindingSchema = z.strictObject({
  deskId: id,
  botId: id,
  role: TradingBotRoleSchema,
  createdAt: instant,
});
export const tradingControlContract = {
  participants: oc
    .input(z.strictObject({}))
    .output(z.array(z.strictObject({ id, name: z.string() }))),
  bindBot: oc
    .input(z.strictObject({ deskId: id, botId: id, role: TradingBotRoleSchema }))
    .output(TradingBotBindingSchema),
  unbindBot: oc
    .input(z.strictObject({ deskId: id, botId: id }))
    .output(z.strictObject({ removed: z.boolean() })),
  createDesk: oc
    .input(
      z.strictObject({
        scope: TradingScopeSchema.extend({ environment: z.literal("simulation") }),
        algorithmApproverUserId: id,
        tradeApproverUserId: id,
        botId: id.optional(),
      }),
    )
    .output(TradingDeskSchema),
  desks: oc.input(z.strictObject({ botId: id.optional() })).output(z.array(TradingDeskSchema)),
  desk: oc.input(deskId).output(
    z.strictObject({
      desk: TradingDeskSchema,
      simulationScenario: TradingSimulationScenarioSchema.default("immediate_fill"),
      versions: z.array(TradingVersionSchema),
      intents: z.array(TradingStoredIntentSchema),
      grants: z.array(TradingGrantSchema),
      executions: z.array(TradingExecutionSchema),
      audit: z.array(TradingAuditSchema),
      bindings: z.array(TradingBotBindingSchema),
    }),
  ),
  prepareIntent: oc
    .input(z.strictObject({ deskId: id, analysisId: id, expiresAt: instant }))
    .output(TradingStoredIntentSchema),
  approveAlgorithm: oc
    .input(z.strictObject({ deskId: id, versionId: id, expectedArtifactHash: hash }))
    .output(TradingVersionSchema),
  retireAlgorithm: oc
    .input(z.strictObject({ deskId: id, versionId: id }))
    .output(TradingVersionSchema),
  approveIntent: oc
    .input(z.strictObject({ deskId: id, intentId: id, expectedIntentHash: hash }))
    .output(TradingStoredIntentSchema),
  createGrant: oc
    .input(
      z.strictObject({
        deskId: id,
        versionId: id,
        botId: id.optional(),
        perTradeLimitCny: money,
        cumulativeLimitCny: money,
        allowCancellation: z.boolean().optional(),
        expiresAt: instant,
      }),
    )
    .output(TradingGrantSchema),
  revokeGrant: oc.input(z.strictObject({ deskId: id, grantId: id })).output(TradingGrantSchema),
  executeSimulation: oc
    .input(
      z.strictObject({
        deskId: id,
        intentId: id,
        clientRequestId: id,
        expectedIntentHash: hash,
        grantId: id.optional(),
      }),
    )
    .output(TradingExecutionSchema),
  configureSimulation: oc
    .input(z.strictObject({ deskId: id, scenario: TradingSimulationScenarioSchema }))
    .output(z.strictObject({ scenario: TradingSimulationScenarioSchema })),
  reconcileExecution: oc
    .input(
      z.strictObject({
        deskId: id,
        executionId: id,
        expectedSequence: z.number().int().positive(),
      }),
    )
    .output(TradingExecutionSchema),
  cancelSimulation: oc
    .input(z.strictObject({ deskId: id, executionId: id, clientRequestId: id }))
    .output(TradingExecutionSchema),
  executionByRequest: oc
    .input(z.strictObject({ deskId: id, clientRequestId: id }))
    .output(TradingExecutionSchema),
};
export type TradingDesk = z.infer<typeof TradingDeskSchema>;
export type TradingVersion = z.infer<typeof TradingVersionSchema>;
export type TradingStoredIntent = z.infer<typeof TradingStoredIntentSchema>;
export type TradingControlInputs = InferContractRouterInputs<typeof tradingControlContract>;

export const TradingBotCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("learning_open"), deskId: id }),
  z.strictObject({
    operation: z.literal("learning_propose"),
    deskId: id,
    proposal: TradingLearningProposalSchema,
  }),
  z.strictObject({
    operation: z.literal("learning_schedule"),
    deskId: id,
    schedule: TradingLearningScheduleSchema,
    baselineMargin: TradingUnsignedDecimalSchema.default("0"),
  }),
  z.strictObject({ operation: z.literal("learning_start"), deskId: id, clientRequestId: id }),
  z.strictObject({ operation: z.literal("learning_capture_message"), deskId: id, messageId: id }),
  z.strictObject({
    operation: z.literal("reconcile"),
    deskId: id,
    executionId: id,
    expectedSequence: z.number().int().positive(),
  }),
  z.strictObject({
    operation: z.literal("cancel"),
    deskId: id,
    executionId: id,
    clientRequestId: id,
  }),
  z.strictObject({ operation: z.literal("weather"), deskId: id, siteId: id.optional() }),
  z.strictObject({ operation: z.literal("scopes") }),
  z.strictObject({ operation: z.literal("context"), deskId: id }),
  z.strictObject({
    operation: z.literal("analyze"),
    deskId: id,
    margin: TradingUnsignedDecimalSchema.default("0"),
  }),
  z.strictObject({ operation: z.literal("prepare"), deskId: id, analysisId: id }),
  z.strictObject({
    operation: z.literal("execute"),
    deskId: id,
    intentId: id,
    expectedIntentHash: hash,
    clientRequestId: id,
    grantId: id.optional(),
  }),
]);
export function tradingBotJsonSchema() {
  return z.toJSONSchema(TradingBotCommandSchema, { io: "input" });
}

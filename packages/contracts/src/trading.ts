import * as z from "zod";

/** Wire values use decimal strings; amounts must never pass through JSON floating point. */
export const TradingDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
export const TradingUnsignedDecimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const positive = TradingUnsignedDecimalSchema.refine(
  (value) => Number(value) > 0,
  "Must be positive",
);
const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
export const TradingEnvironmentSchema = z.enum(["simulation", "live"]);
export const TradingSubjectKindSchema = z.enum(["retailer", "generator", "storage"]);
export const TradingScopeSchema = z.strictObject({
  subjectId: id,
  subjectKind: TradingSubjectKindSchema,
  accountId: id,
  assetId: id.optional(),
  region: z.enum(["CN-SH", "CN-JS", "CN-SD"]),
  marketId: id,
  productId: id,
  stage: z.enum(["mid_long_term", "day_ahead", "intraday", "realtime"]),
  environment: TradingEnvironmentSchema,
});
export const TradingSourceSchema = z.strictObject({
  sourceId: id,
  kind: z.enum(["synthetic", "company", "user"]),
  observedAt: instant,
  asOf: instant,
  validUntil: instant,
  revision: id,
});
export const TradingWindowSchema = z.strictObject({ from: instant, to: instant });
export const TradingRulesSchema = z.strictObject({
  id,
  version: id,
  source: TradingSourceSchema,
  verification: z.enum(["synthetic", "verified", "unverified"]),
  effectiveFrom: instant,
  effectiveTo: instant,
  timezone: z.string().min(1).max(80),
  currency: z.literal("CNY"),
  intervalMinutes: z.number().int().min(1).max(1440),
  priceMin: TradingDecimalSchema,
  priceMax: TradingDecimalSchema,
  priceStep: positive,
  energyStep: positive,
  maxSnapshotAgeSeconds: z.number().int().min(1).max(31_536_000),
});
const interval = { start: instant, end: instant };
const price = TradingDecimalSchema;
const energy = TradingUnsignedDecimalSchema;
const offer = z.strictObject({ offerId: id, price, availableEnergyMwh: energy });
export const TradingRetailInputSchema = z.strictObject({
  kind: z.literal("retailer"),
  intervals: z
    .array(
      z.strictObject({
        ...interval,
        forecastDemandMwh: energy,
        contractedEnergyMwh: energy,
        purchaseOffers: z.array(offer).min(1).max(1000),
        saleOffers: z.array(offer).max(1000),
      }),
    )
    .min(1)
    .max(672),
});
export const TradingGenerationInputSchema = z.strictObject({
  kind: z.literal("generator"),
  intervals: z
    .array(
      z.strictObject({
        ...interval,
        availableEnergyMwh: energy,
        committedEnergyMwh: energy,
        forecastPrice: price,
        segments: z
          .array(
            z.strictObject({
              segmentId: id,
              energyMwh: energy,
              marginalCost: price,
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .min(1)
    .max(672),
});
export const TradingStorageInputSchema = z.strictObject({
  kind: z.literal("storage"),
  capacityMwh: positive,
  initialEnergyMwh: energy,
  minEnergyMwh: energy,
  maxEnergyMwh: positive,
  terminalMinEnergyMwh: energy,
  maxChargeMw: positive,
  maxDischargeMw: positive,
  chargeEfficiency: positive,
  dischargeEfficiency: positive,
  degradationCostPerMwh: energy,
  intervals: z
    .array(z.strictObject({ ...interval, forecastPrice: price }))
    .min(1)
    .max(672),
});
export const TradingInputSchema = z.discriminatedUnion("kind", [
  TradingRetailInputSchema,
  TradingGenerationInputSchema,
  TradingStorageInputSchema,
]);
export const TradingSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  snapshotId: id,
  scope: TradingScopeSchema,
  source: TradingSourceSchema,
  rules: TradingRulesSchema,
  input: TradingInputSchema,
});
export const TradingOrderLineSchema = z.strictObject({
  ...interval,
  side: z.enum(["buy", "sell"]),
  energyMwh: positive,
  limitPrice: price,
  referenceId: id.optional(),
});
export const TradingIntentSchema = z.strictObject({
  intentId: id,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  scope: TradingScopeSchema,
  algorithmVersionId: id,
  snapshotId: id,
  ruleVersion: id,
  lines: z.array(TradingOrderLineSchema).min(1).max(2000),
  expiresAt: instant,
});
export const TradingReceiptSchema = z.strictObject({
  executionId: id,
  clientRequestId: id,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  scope: TradingScopeSchema,
  status: z.enum(["accepted", "partially_filled", "filled", "rejected", "cancelled", "unknown"]),
  source: TradingSourceSchema,
  sequence: z.number().int().nonnegative(),
  fills: z
    .array(
      z.strictObject({
        fillId: id,
        lineIndex: z.number().int().nonnegative(),
        energyMwh: positive,
        price,
        occurredAt: instant,
      }),
    )
    .max(10000),
  message: z.string().max(2000).optional(),
});
export const TradingObservationSchema = z.strictObject({
  id,
  scope: TradingScopeSchema,
  source: TradingSourceSchema,
  kind: z.enum(["chat", "file", "operation", "history"]),
  occurredAt: instant,
  content: z.string().min(1).max(100000),
  snapshotIds: z.array(id).max(1000),
  executionIds: z.array(id).max(1000),
});
export const TradingExternalErrorSchema = z.strictObject({
  code: z.enum([
    "NOT_CONFIGURED",
    "INVALID_INPUT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "STALE_DATA",
    "RULES_UNVERIFIED",
    "IDEMPOTENCY_CONFLICT",
    "RATE_LIMITED",
    "UNAVAILABLE",
  ]),
  message: z.string().max(2000),
  requestId: id,
  retryable: z.boolean(),
});
export const TradingSnapshotQuerySchema = z.strictObject({
  scope: TradingScopeSchema,
  window: TradingWindowSchema,
});
export const TradingObservationQuerySchema = z.strictObject({
  scope: TradingScopeSchema,
  window: TradingWindowSchema,
  cursor: id.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const TradingExecutionRequestSchema = z.strictObject({
  clientRequestId: id,
  intent: TradingIntentSchema,
});
export const TradingCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  environments: z.array(TradingEnvironmentSchema).min(1),
  subjectKinds: z.array(TradingSubjectKindSchema).min(1),
  supportsExecution: z.boolean(),
  supportsCancellation: z.boolean(),
  supportsObservations: z.boolean(),
  sourceId: id,
});

/** One definition drives validation and the agent handoff's OpenAPI document. */
export const tradingExternalOperations = {
  capabilities: {
    method: "get",
    path: "/v1/capabilities",
    input: z.strictObject({}),
    output: TradingCapabilitiesSchema,
  },
  scopes: {
    method: "get",
    path: "/v1/scopes",
    input: z.strictObject({}),
    output: z.strictObject({ scopes: z.array(TradingScopeSchema).max(10000) }),
  },
  snapshot: {
    method: "post",
    path: "/v1/snapshots/query",
    input: TradingSnapshotQuerySchema,
    output: TradingSnapshotSchema,
  },
  observations: {
    method: "post",
    path: "/v1/observations/query",
    input: TradingObservationQuerySchema,
    output: z.strictObject({
      items: z.array(TradingObservationSchema).max(200),
      nextCursor: id.nullable(),
    }),
  },
  submit: {
    method: "post",
    path: "/v1/executions",
    input: TradingExecutionRequestSchema,
    output: TradingReceiptSchema,
  },
  receipt: {
    method: "get",
    path: "/v1/executions/by-request/{clientRequestId}",
    input: z.strictObject({ clientRequestId: id }),
    output: TradingReceiptSchema,
  },
  cancel: {
    method: "post",
    path: "/v1/executions/{executionId}/cancel",
    input: z.strictObject({
      executionId: id,
      clientRequestId: id,
      reason: z.string().min(1).max(2000),
    }),
    output: TradingReceiptSchema,
  },
} as const;

export type TradingScope = z.infer<typeof TradingScopeSchema>;
export type TradingSource = z.infer<typeof TradingSourceSchema>;
export type TradingRules = z.infer<typeof TradingRulesSchema>;
export type TradingInput = z.infer<typeof TradingInputSchema>;
export type TradingSnapshot = z.infer<typeof TradingSnapshotSchema>;
export type TradingIntent = z.infer<typeof TradingIntentSchema>;
export type TradingOrderLine = z.infer<typeof TradingOrderLineSchema>;
export type TradingReceipt = z.infer<typeof TradingReceiptSchema>;
export type TradingObservation = z.infer<typeof TradingObservationSchema>;

export function tradingSnapshotJsonSchema() {
  return z.toJSONSchema(TradingSnapshotSchema);
}

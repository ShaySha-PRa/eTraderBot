import * as z from "zod";
import { ReadonlySourceDataSchema, ReadonlySourceFailureSchema } from "./readonly-source.js";

export const TOOL_RESULT_SUMMARY_MAX_BYTES = 8 * 1024;
const instant = z.iso.datetime({ offset: true }).max(35);
const success = z
  .strictObject({
    kind: z.literal("readonly_source"),
    schemaVersion: z.literal(1),
    outcome: z.literal("success"),
    source: ReadonlySourceDataSchema.shape.source.extend({ generatedAt: instant }),
    date: z.iso.date().max(10),
    candidateOnly: z.literal(true),
    periods: z
      .array(
        z.strictObject({
          start: instant,
          end: instant,
          forecastMWh: z.number().nonnegative().finite(),
        }),
      )
      .min(1)
      .max(24),
  })
  .superRefine((summary, ctx) => {
    const checked = ReadonlySourceDataSchema.safeParse({
      ok: true,
      source: summary.source,
      date: summary.date,
      candidateOnly: summary.candidateOnly,
      periods: summary.periods,
    });
    if (!checked.success) ctx.addIssue({ code: "custom", message: "Invalid candidate intervals" });
  });

/** A deliberately closed display contract, never arbitrary connector text or parameters. */
export const SafeReadonlySourceSummarySchema = z.union([
  success,
  z.strictObject({
    kind: z.literal("readonly_source"),
    schemaVersion: z.literal(1),
    outcome: z.literal("error"),
    workspaceId: z.string().min(1).max(128),
    errorCode: ReadonlySourceFailureSchema.shape.error.shape.code,
    retryable: z.boolean(),
  }),
]);
export type SafeReadonlySourceSummary = z.infer<typeof SafeReadonlySourceSummarySchema>;

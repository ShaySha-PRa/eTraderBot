import * as z from "zod";

export const ReadonlySourceQuerySchema = z.strictObject({
  date: z.iso.date(),
  version: z.literal("synthetic-load-v1").default("synthetic-load-v1"),
});

/** Candidate data from the integration example, never a formal business evidence record. */
export const ReadonlySourceDataSchema = z
  .strictObject({
    ok: z.literal(true),
    source: z.strictObject({
      kind: z.literal("synthetic"),
      sourceId: z.literal("synthetic-load-example"),
      workspaceId: z.string().min(1).max(128),
      version: z.literal("synthetic-load-v1"),
      generatedAt: z.iso.datetime({ offset: true }),
      timezone: z.literal("Asia/Shanghai"),
    }),
    date: z.iso.date(),
    candidateOnly: z.literal(true),
    periods: z
      .array(
        z.strictObject({
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }),
          forecastMWh: z.number().nonnegative().finite(),
        }),
      )
      .min(1)
      .max(24),
  })
  .superRefine((data, ctx) => {
    const dayStart = Date.parse(`${data.date}T00:00:00+08:00`);
    let previousEnd = dayStart;
    for (const [index, period] of data.periods.entries()) {
      const start = Date.parse(period.start),
        end = Date.parse(period.end);
      if (start < previousEnd || end <= start || end > dayStart + 86_400_000)
        ctx.addIssue({
          code: "custom",
          path: ["periods", index],
          message: "Invalid forecast interval",
        });
      previousEnd = end;
    }
  });

export const ReadonlySourceFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum([
      "INVALID_QUERY",
      "SOURCE_TIMEOUT",
      "SOURCE_UNREACHABLE",
      "SOURCE_INVALID_RESPONSE",
      "SOURCE_AUTH_FAILED",
      "SOURCE_NO_DATA",
    ]),
    message: z.string(),
    retryable: z.boolean(),
  }),
});
export const ReadonlySourceResultSchema = z.union([
  ReadonlySourceDataSchema,
  ReadonlySourceFailureSchema,
]);
export type ReadonlySourceData = z.infer<typeof ReadonlySourceDataSchema>;
export type ReadonlySourceResult = z.infer<typeof ReadonlySourceResultSchema>;

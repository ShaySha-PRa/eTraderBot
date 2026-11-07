import * as z from "zod";
import { TicketStatusSchema } from "./board.js";
import { Id, IsoDate, RunStatus } from "./ids.js";
import { RUN_ERROR_KINDS, RunTriggerSchema } from "./runs.js";
import { SafeReadonlySourceSummarySchema } from "./tool-result-summary.js";

/** Safe categories only: never expose raw provider errors, prompts or tool payloads. */
export const RunTraceReasonSchema = z.enum([
  "waiting_input",
  "waiting_takeover",
  "stopped",
  "failure",
  ...RUN_ERROR_KINDS,
]);
export const RunTraceRowSchema = z.object({
  runId: Id,
  taskId: Id,
  botId: Id,
  botName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  retryOfRunId: Id.nullable(),
  reason: RunTraceReasonSchema.nullable(),
});
export type RunTraceRow = z.infer<typeof RunTraceRowSchema>;
export const RunTraceCursorSchema = z.object({ runId: Id, createdAt: IsoDate });
export const RunsForTicketInputSchema = z.object({
  ticketId: Id,
  limit: z.number().int().min(1).max(100).default(20),
  cursor: RunTraceCursorSchema.optional(),
});
export const RunsForTicketOutputSchema = z.object({
  runs: z.array(RunTraceRowSchema),
  nextCursor: RunTraceCursorSchema.nullable(),
});
export const RunToolStatusSchema = z.enum([
  "pending",
  "waiting",
  "completed",
  "failed",
  "refused",
  "ambiguous",
]);
export type RunToolStatus = z.infer<typeof RunToolStatusSchema>;
export const RunToolTraceSchema = z.object({
  id: Id,
  attemptId: Id,
  name: z.string(),
  status: RunToolStatusSchema,
  startedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  /** Absent/null means not recorded or not eligible; never infer a result from steps. */
  resultSummary: SafeReadonlySourceSummarySchema.nullable().optional(),
});
export const RunTraceDetailSchema = RunTraceRowSchema.extend({
  ticket: z
    .object({ id: Id, ref: z.string(), title: z.string(), status: TicketStatusSchema })
    .nullable(),
  waiting: z.object({ kind: z.enum(["input", "takeover"]) }).nullable(),
  timing: z.object({
    queuedMs: z.number().nonnegative().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    firstResponseMs: z.number().nonnegative().nullable(),
  }),
  usage: z.object({
    recordCount: z.number().int().nonnegative(),
    totalTokens: z.number().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    costKnown: z.boolean(),
  }),
  toolTrace: z.object({
    /** False means no complete instrumentation record, not "no tools used". */
    recorded: z.boolean(),
    calls: z.array(RunToolTraceSchema),
    truncated: z.boolean(),
  }),
});
export type RunTraceDetail = z.infer<typeof RunTraceDetailSchema>;

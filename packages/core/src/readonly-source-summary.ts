import type { RunToolStatus, SafeReadonlySourceSummary } from "@rakazo/contracts";
import { SafeReadonlySourceSummarySchema, TOOL_RESULT_SUMMARY_MAX_BYTES } from "@rakazo/contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Re-project on both persistence and readback. Unknown keys and error messages never escape. */
export function safeReadonlySourceSummary(
  value: unknown,
  workspaceId: string,
  status: RunToolStatus,
): SafeReadonlySourceSummary | null {
  const row = record(value);
  if (row.kind !== "readonly_source" || row.schemaVersion !== 1) return null;
  let candidate: unknown;
  if (row.outcome === "success" && status === "completed") {
    const source = record(row.source);
    if (
      source.workspaceId !== workspaceId ||
      !Array.isArray(row.periods) ||
      row.periods.length > 24
    )
      return null;
    candidate = {
      kind: row.kind,
      schemaVersion: row.schemaVersion,
      outcome: row.outcome,
      source: {
        kind: source.kind,
        sourceId: source.sourceId,
        workspaceId,
        version: source.version,
        generatedAt: source.generatedAt,
        timezone: source.timezone,
      },
      date: row.date,
      candidateOnly: row.candidateOnly,
      periods: row.periods.map((item) => {
        const period = record(item);
        return { start: period.start, end: period.end, forecastMWh: period.forecastMWh };
      }),
    };
  } else if (row.outcome === "error" && status === "failed" && row.workspaceId === workspaceId) {
    candidate = {
      kind: row.kind,
      schemaVersion: row.schemaVersion,
      outcome: row.outcome,
      workspaceId,
      errorCode: row.errorCode,
      retryable: row.retryable,
    };
  } else return null;
  const parsed = SafeReadonlySourceSummarySchema.safeParse(candidate);
  if (
    !parsed.success ||
    new TextEncoder().encode(JSON.stringify(parsed.data)).length > TOOL_RESULT_SUMMARY_MAX_BYTES
  )
    return null;
  return parsed.data;
}

/** Called only for the resolved, registered readonly sample route after connector redaction. */
export function readonlySourceResultSummary(
  result: unknown,
  workspaceId: string,
  status: RunToolStatus,
): SafeReadonlySourceSummary | null {
  const outer = record(result);
  const envelope = record(outer.details ?? result);
  const data = record(envelope.structuredContent);
  if (data.ok === true && envelope.isError !== true)
    return safeReadonlySourceSummary(
      {
        kind: "readonly_source",
        schemaVersion: 1,
        outcome: "success",
        source: data.source,
        date: data.date,
        candidateOnly: data.candidateOnly,
        periods: data.periods,
      },
      workspaceId,
      status,
    );
  if (data.ok === false && envelope.isError === true) {
    const error = record(data.error);
    return safeReadonlySourceSummary(
      {
        kind: "readonly_source",
        schemaVersion: 1,
        outcome: "error",
        workspaceId,
        errorCode: error.code,
        retryable: error.retryable,
      },
      workspaceId,
      status,
    );
  }
  return null;
}

import { describe, expect, it } from "vitest";
import {
  readonlySourceResultSummary,
  safeReadonlySourceSummary,
} from "./readonly-source-summary.js";

const workspaceId = "synthetic-workspace";
const marker = "synthetic-sensitive-credential";
function data() {
  return {
    ok: true,
    source: {
      kind: "synthetic",
      sourceId: "synthetic-load-example",
      workspaceId,
      version: "synthetic-load-v1",
      generatedAt: "2026-11-07T16:00:00+08:00",
      timezone: "Asia/Shanghai",
    },
    date: "2026-11-08",
    candidateOnly: true,
    periods: [
      { start: "2026-11-08T00:00:00+08:00", end: "2026-11-08T01:00:00+08:00", forecastMWh: 12.5 },
    ],
  };
}

describe("safe readonly source display summaries", () => {
  it("projects only bounded source facts, ignoring credentials and arbitrary fields at every level", () => {
    const original = data();
    const result = {
      isError: false,
      content: [{ text: marker }],
      arguments: { credential: marker },
      structuredContent: {
        ...original,
        credential: marker,
        source: { ...original.source, authorization: marker },
        periods: original.periods.map((period) => ({ ...period, secret: marker })),
      },
    };
    const summary = readonlySourceResultSummary(result, workspaceId, "completed");
    expect(summary).toEqual({
      kind: "readonly_source",
      schemaVersion: 1,
      outcome: "success",
      source: original.source,
      date: original.date,
      candidateOnly: true,
      periods: original.periods,
    });
    expect(JSON.stringify(summary)).not.toContain(marker);
    expect(
      safeReadonlySourceSummary({ ...summary, prompt: marker }, workspaceId, "completed"),
    ).toEqual(summary);
  });

  it("keeps stable failure codes without returning upstream error text, secrets or parameters", () => {
    const result = {
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "SOURCE_TIMEOUT",
          message: marker,
          retryable: true,
          raw: marker,
        },
      },
      content: [{ text: marker }],
    };
    const summary = readonlySourceResultSummary(result, workspaceId, "failed");
    expect(summary).toEqual({
      kind: "readonly_source",
      schemaVersion: 1,
      outcome: "error",
      workspaceId,
      errorCode: "SOURCE_TIMEOUT",
      retryable: true,
    });
    expect(
      readonlySourceResultSummary(
        { ...result, structuredContent: { ok: false, error: { code: marker, retryable: true } } },
        workspaceId,
        "failed",
      ),
    ).toBeNull();
  });

  it.each(["pending", "waiting", "failed", "refused", "ambiguous"] as const)(
    "does not publish a success summary for a %s outcome",
    (status) => {
      expect(
        readonlySourceResultSummary({ structuredContent: data() }, workspaceId, status),
      ).toBeNull();
    },
  );

  it("rejects foreign scope, unbounded identifiers, invalid times and excess periods", () => {
    for (const payload of [
      { ...data(), source: { ...data().source, workspaceId: "another-business" } },
      { ...data(), source: { ...data().source, sourceId: marker } },
      { ...data(), source: { ...data().source, version: marker } },
      { ...data(), source: { ...data().source, generatedAt: marker.repeat(20) } },
      { ...data(), candidateOnly: false },
      { ...data(), periods: Array.from({ length: 25 }, () => data().periods[0]) },
      { ...data(), periods: [{ ...data().periods[0], forecastMWh: Number.POSITIVE_INFINITY }] },
      { ...data(), periods: [{ ...data().periods[0], end: "2026-11-08T00:00:00+08:00" }] },
    ])
      expect(
        readonlySourceResultSummary({ structuredContent: payload }, workspaceId, "completed"),
      ).toBeNull();
    expect(
      readonlySourceResultSummary(
        {
          structuredContent: {
            ...data(),
            source: { ...data().source, workspaceId: "x".repeat(129) },
          },
        },
        "x".repeat(129),
        "completed",
      ),
    ).toBeNull();
  });

  it("does not reconstruct missing or legacy results from model text", () => {
    expect(safeReadonlySourceSummary(null, workspaceId, "completed")).toBeNull();
    expect(
      readonlySourceResultSummary(
        { content: [{ text: JSON.stringify(data()) }] },
        workspaceId,
        "completed",
      ),
    ).toBeNull();
    expect(
      readonlySourceResultSummary(
        { isError: true, structuredContent: data() },
        workspaceId,
        "completed",
      ),
    ).toBeNull();
  });
});

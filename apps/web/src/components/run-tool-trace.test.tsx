// @vitest-environment jsdom
import type { RunTraceDetail, SafeReadonlySourceSummary } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { runs },
  rpcForSpace: () => ({ runs }),
  createSpaceRpc: () => ({ runs }),
  selectedSpaceId: () => null,
}));

/** The interface language; switching it re-renders like the real provider does. */
const language = vi.hoisted(() => ({ locale: "en", listeners: new Set<() => void>() }));
const translate = vi.hoisted(
  () =>
    (parts: TemplateStringsArray, ...values: unknown[]) =>
      (language.locale === "en" ? "" : `[${language.locale}] `) + String.raw(parts, ...values),
);
vi.mock("@lingui/core/macro", () => ({ t: translate }));
vi.mock("@lingui/react/macro", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    language.listeners.add(listener);
    return () => language.listeners.delete(listener);
  };
  return {
    Trans: ({ children }: { children: ReactNode }) => children,
    useLingui: () => {
      const locale = useSyncExternalStore(subscribe, () => language.locale);
      return { t: translate, i18n: { locale } };
    },
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button type="button" {...props} />
  ),
  Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
}));

import { RunToolCalls } from "./run-tool-trace";

type Call = RunTraceDetail["toolTrace"]["calls"][number];
const workspaceId = "space-a";
const success: SafeReadonlySourceSummary = {
  kind: "readonly_source",
  schemaVersion: 1,
  outcome: "success",
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
    { start: "2026-11-08T01:00:00+08:00", end: "2026-11-08T02:00:00+08:00", forecastMWh: 13.5 },
  ],
};
const unreachable: SafeReadonlySourceSummary = {
  kind: "readonly_source",
  schemaVersion: 1,
  outcome: "error",
  workspaceId,
  errorCode: "SOURCE_UNREACHABLE",
  retryable: true,
};

function call(id: string, status: Call["status"], extra: Partial<Call> = {}): Call {
  return {
    id,
    attemptId: "attempt-1",
    name: "mcp__readonly-example__read_synthetic_load",
    status,
    startedAt: "2026-11-07T08:00:00.000Z",
    finishedAt: "2026-11-07T08:00:01.000Z",
    durationMs: 1000,
    ...extra,
  };
}

function detail(
  calls: Call[],
  trace: Partial<RunTraceDetail["toolTrace"]> = {},
  status: RunTraceDetail["status"] = "completed",
): RunTraceDetail {
  return {
    runId: "run-1",
    taskId: "task-1",
    botId: "bot-1",
    botName: "Risk desk",
    threadId: "thread-1",
    status,
    trigger: "user",
    createdAt: "2026-11-07T08:00:00.000Z",
    startedAt: "2026-11-07T08:00:00.000Z",
    completedAt: "2026-11-07T08:00:02.000Z",
    retryOfRunId: null,
    reason: null,
    ticket: null,
    waiting: null,
    timing: { queuedMs: null, durationMs: null, firstResponseMs: null },
    usage: { recordCount: 0, totalTokens: null, costUsd: null, costKnown: false },
    toolTrace: { recorded: true, calls, truncated: false, ...trace },
  } as RunTraceDetail;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  language.locale = "en";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  runs.detail.mockReset();
  document.body.innerHTML = "";
});

async function mounted(runId = "run-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RunToolCalls runId={runId} />
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    settled: (check: () => void) => act(async () => vi.waitFor(check)),
    text: () => container.textContent ?? "",
    summaries: () => [...container.querySelectorAll('[data-testid="tool-result-summary"]')],
  };
}

it("shows a read's source, business, periods, version and candidate marker from its safe summary", async () => {
  runs.detail.mockResolvedValue(detail([call("c1", "completed", { resultSummary: success })]));
  const view = await mounted();
  await view.settled(() => expect(view.summaries()).toHaveLength(1));
  expect(runs.detail).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());
  const summary = view.summaries()[0]!;
  expect(summary.querySelector("summary")?.textContent).toBe("Source details");
  const text = summary.textContent ?? "";
  expect(text).toContain("Synthetic · synthetic-load-example");
  expect(text).toContain(workspaceId);
  expect(text).toContain("synthetic-load-v1");
  expect(text).toContain("2026-11-08");
  expect(text).toContain("00:00–01:00 · 12.5 MWh");
  expect(text).toContain("01:00–02:00 · 13.5 MWh");
  expect(text).toContain("Candidate data only, not recorded as business evidence");
  expect(view.text()).toContain("Done");
});

it("names a failed read by its stable code in the interface language, never as success", async () => {
  runs.detail.mockResolvedValue(detail([call("c1", "failed", { resultSummary: unreachable })]));
  const view = await mounted();
  await view.settled(() => expect(view.summaries()).toHaveLength(1));
  expect(view.text()).toContain("Failed");
  expect(view.text()).not.toContain("Done");
  const summary = view.summaries()[0]!;
  expect(summary.querySelector("summary")?.textContent).toBe("Error details");
  expect(summary.textContent).toContain("The source could not be reached");
  expect(summary.textContent).toContain("You can ask again");
  expect(summary.textContent).not.toContain("periods");
  await act(async () => {
    language.locale = "zh-CN";
    for (const listener of language.listeners) listener();
  });
  expect(summary.textContent).toContain("[zh-CN] The source could not be reached");
});

it("shows a refused call as refused, with no summary, and keeps every attempt", async () => {
  runs.detail.mockResolvedValue(
    detail([
      call("c1", "failed", { attemptId: "attempt-aaaaaaaa", resultSummary: unreachable }),
      call("c2", "completed", {
        attemptId: "attempt-bbbbbbbb",
        startedAt: "2026-11-07T08:00:05.000Z",
        resultSummary: success,
      }),
      call("c3", "refused", {
        attemptId: "attempt-bbbbbbbb",
        startedAt: "2026-11-07T08:00:09.000Z",
      }),
    ]),
  );
  const view = await mounted();
  await view.settled(() =>
    expect(view.container.querySelectorAll('[data-testid="tool-attempt"]')).toHaveLength(2),
  );
  const items = [...view.container.querySelectorAll("li")].filter((li) =>
    li.textContent?.includes("read_synthetic_load"),
  );
  expect(items.map((li) => li.querySelector("span")?.parentElement?.textContent)).toEqual([
    expect.stringContaining("Failed"),
    expect.stringContaining("Done"),
    expect.stringContaining("Refused"),
  ]);
  expect(items[2]!.querySelector('[data-testid="tool-result-summary"]')).toBeNull();
});

it("treats a missing summary, an unrecorded run and a truncated list as exactly that", async () => {
  runs.detail.mockResolvedValue(
    detail([call("c1", "completed"), call("c2", "completed", { resultSummary: null })], {
      recorded: false,
      truncated: true,
    }),
  );
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("Tool summary not recorded"));
  expect(view.summaries()).toHaveLength(0);
  expect(view.text()).toContain("Showing only the first tool calls");
});

it("retries a failed read of the record and does not retry a refused one", async () => {
  runs.detail
    .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "INTERNAL_SERVER_ERROR" }))
    .mockResolvedValueOnce(detail([call("c1", "completed", { resultSummary: success })]));
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("Could not load runs"));
  await act(async () =>
    [...view.container.querySelectorAll("button")]
      .find((b) => b.textContent === "Try again")!
      .click(),
  );
  await view.settled(() => expect(view.summaries()).toHaveLength(1));

  runs.detail.mockRejectedValue(Object.assign(new Error("gone"), { code: "NOT_FOUND" }));
  const gone = await mounted("run-2");
  await gone.settled(() => expect(gone.text()).toContain("This run is no longer available"));
  expect(
    [...gone.container.querySelectorAll("button")].some((b) => b.textContent === "Try again"),
  ).toBe(false);
});

it("polls while a call is still pending and stops once it settles", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runs.detail
    .mockResolvedValueOnce(detail([call("c1", "pending", { finishedAt: null, durationMs: null })]))
    .mockResolvedValue(detail([call("c1", "completed", { resultSummary: success })]));
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("In progress"));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await view.settled(() => expect(view.summaries()).toHaveLength(1));
  const reads = runs.detail.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(runs.detail.mock.calls.length).toBe(reads);
});

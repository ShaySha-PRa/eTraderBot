// @vitest-environment jsdom
import type { RunTraceDetail, RunTraceRow } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({ forTicket: vi.fn(), detail: vi.fn() }));
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

import { TicketRuns } from "./TicketRuns";

const row = (overrides: Partial<RunTraceRow> = {}): RunTraceRow => ({
  runId: "run-1",
  taskId: "task-1",
  botId: "bot-1",
  botName: "Spot desk",
  threadId: "thread-1",
  status: "completed",
  trigger: "tickets",
  createdAt: "2026-11-06T02:00:00.000Z",
  startedAt: "2026-11-06T02:00:01.000Z",
  completedAt: "2026-11-06T02:00:31.000Z",
  retryOfRunId: null,
  reason: null,
  ...overrides,
});
const detail = (overrides: Partial<RunTraceDetail> = {}): RunTraceDetail => ({
  ...row(),
  ticket: { id: "ticket-1", ref: "RAK-1", title: "Check contracts", status: "review" },
  waiting: null,
  timing: { queuedMs: 1000, durationMs: 30_000, firstResponseMs: 2000 },
  usage: { recordCount: 1, totalTokens: 1200, costUsd: 0.0123, costKnown: true },
  toolTrace: {
    recorded: true,
    calls: [
      {
        id: "call-1",
        attemptId: "attempt-1",
        name: "read_evidence",
        status: "completed",
        startedAt: "2026-11-06T02:00:02.000Z",
        finishedAt: "2026-11-06T02:00:03.500Z",
        durationMs: 1500,
      },
      {
        id: "call-2",
        attemptId: "attempt-1",
        name: "submit_result",
        status: "ambiguous",
        startedAt: "2026-11-06T02:00:04.000Z",
        finishedAt: null,
        durationMs: null,
      },
    ],
    truncated: false,
  },
  ...overrides,
});
const refusal = (code: string) => Object.assign(new Error(`raw ${code} text`), { code });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  language.locale = "en";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  runs.forTicket.mockReset();
  runs.detail.mockReset();
  document.body.innerHTML = "";
});

async function mounted() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TicketRuns ticketId="ticket-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    settled: (check: () => void) => act(async () => vi.waitFor(check)),
    button: (name: string | RegExp) =>
      [...container.querySelectorAll("button")].find((b) =>
        typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? ""),
      ),
    text: () => container.textContent ?? "",
  };
}

async function switchLanguage(locale: string) {
  await act(async () => {
    language.locale = locale;
    for (const listener of language.listeners) listener();
  });
}

it("says no linked runs were recorded rather than that the ticket never ran", async () => {
  runs.forTicket.mockResolvedValue({ runs: [], nextCursor: null });
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("No linked runs recorded"));
  expect(runs.forTicket).toHaveBeenCalledWith({ ticketId: "ticket-1" }, expect.anything());
});

it("lists runs newest first with Shanghai times, retries and safe reasons, and pages older ones", async () => {
  runs.forTicket
    .mockResolvedValueOnce({
      runs: [
        row({ runId: "run-2", retryOfRunId: "run-1", status: "failed", reason: "rate" }),
        row({ runId: "run-1", status: "cancelled", reason: "stopped", botName: null }),
      ],
      nextCursor: { runId: "run-1", createdAt: "2026-11-06T02:00:00.000Z" },
    })
    .mockResolvedValueOnce({ runs: [row({ runId: "run-0" })], nextCursor: null });
  const view = await mounted();
  await view.settled(() => expect(view.container.querySelectorAll("li")).toHaveLength(2));
  const [retry, stopped] = view.container.querySelectorAll("li");
  expect(retry!.textContent).toContain("Failed");
  expect(retry!.textContent).toContain("Retry of #run-1");
  expect(retry!.textContent).toContain("Model rate limited");
  // 02:00 UTC is 10:00 in Shanghai, whatever the test machine's zone.
  expect(retry!.querySelector("time")!.textContent).toMatch(/10:00/);
  expect(stopped!.textContent).toContain("Bot not recorded");
  expect(stopped!.textContent).toContain("Stopped");

  await act(async () => view.button("Load older runs")!.click());
  await view.settled(() => expect(view.container.querySelectorAll("li")).toHaveLength(3));
  expect(runs.forTicket).toHaveBeenLastCalledWith(
    {
      ticketId: "ticket-1",
      cursor: { runId: "run-1", createdAt: "2026-11-06T02:00:00.000Z" },
    },
    expect.anything(),
  );
  expect(view.button("Load older runs")).toBeUndefined();
});

it("opens a run's detail with ticket status apart from the run, tools and recorded cost", async () => {
  runs.forTicket.mockResolvedValue({ runs: [row()], nextCursor: null });
  runs.detail.mockResolvedValue(detail());
  const view = await mounted();
  await view.settled(() => expect(view.button(/Spot desk/)).toBeDefined());
  await act(async () => view.button(/Spot desk/)!.click());
  await view.settled(() => expect(view.text()).toContain("read_evidence"));
  const panel = view.container.querySelector('[data-testid="run-detail"]')!;
  expect(panel.textContent).toContain("Done");
  expect(panel.textContent).toContain("RAK-1 · In review");
  expect(panel.textContent).toContain("Result unknown");
  expect(panel.textContent).toContain("$0.0123");
  expect(panel.querySelector('a[href="/app/bot-1"]')?.textContent).toBe("Spot desk");
  expect(runs.detail).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());

  await act(async () => view.button("All runs")!.click());
  expect(view.container.querySelector('[data-testid="run-detail"]')).toBeNull();
  expect(view.container.querySelectorAll("li")).toHaveLength(1);
});

it("never shows unknown cost or unrecorded tools as zero or none", async () => {
  runs.forTicket.mockResolvedValue({ runs: [row()], nextCursor: null });
  runs.detail.mockResolvedValue(
    detail({
      timing: { queuedMs: null, durationMs: null, firstResponseMs: null },
      usage: { recordCount: 2, totalTokens: null, costUsd: null, costKnown: false },
      toolTrace: { recorded: false, calls: [], truncated: false },
      ticket: null,
    }),
  );
  const view = await mounted();
  await view.settled(() => expect(view.button(/Spot desk/)).toBeDefined());
  await act(async () => view.button(/Spot desk/)!.click());
  await view.settled(() => expect(view.text()).toContain("Tool summary not recorded"));
  expect(view.text()).toContain("Unknown");
  expect(view.text()).not.toContain("$0");
  expect(view.text()).not.toContain("No tool calls recorded");
  expect(view.text()).toContain("No ticket link recorded");
  expect(view.text()).toContain("Not recorded");
});

it("keeps partial tool calls under the not-recorded note and marks a truncated list", async () => {
  runs.forTicket.mockResolvedValue({ runs: [row()], nextCursor: null });
  const base = detail();
  runs.detail.mockResolvedValue(
    detail({ toolTrace: { ...base.toolTrace, recorded: false, truncated: true } }),
  );
  const view = await mounted();
  await view.settled(() => expect(view.button(/Spot desk/)).toBeDefined());
  await act(async () => view.button(/Spot desk/)!.click());
  await view.settled(() => expect(view.text()).toContain("read_evidence"));
  expect(view.text()).toContain("Tool summary not recorded");
  expect(view.text()).toContain("Showing only the first tool calls");
});

it("retries a failed list load and words the error in the interface language", async () => {
  runs.forTicket
    .mockRejectedValueOnce(refusal("INTERNAL_SERVER_ERROR"))
    .mockResolvedValueOnce({ runs: [row()], nextCursor: null });
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("Could not load runs"));
  expect(view.text()).not.toContain("raw INTERNAL_SERVER_ERROR text");
  await switchLanguage("zh-CN");
  expect(view.text()).toContain("[zh-CN] Could not load runs");
  await act(async () => view.button("Try again")!.click());
  await view.settled(() => expect(view.container.querySelectorAll("li")).toHaveLength(1));
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("shows a refused detail without a retry that cannot help", async () => {
  runs.forTicket.mockResolvedValue({ runs: [row()], nextCursor: null });
  runs.detail.mockRejectedValue(refusal("NOT_FOUND"));
  const view = await mounted();
  await view.settled(() => expect(view.button(/Spot desk/)).toBeDefined());
  await act(async () => view.button(/Spot desk/)!.click());
  await view.settled(() => expect(view.text()).toContain("This run is no longer available"));
  expect(view.button("Try again")).toBeUndefined();
  expect(view.text()).not.toContain("raw NOT_FOUND text");
});

it("polls an open active run until it settles", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runs.forTicket.mockResolvedValue({ runs: [row({ status: "running" })], nextCursor: null });
  runs.detail
    .mockResolvedValueOnce(detail({ status: "running", completedAt: null }))
    .mockResolvedValue(detail());
  const view = await mounted();
  await view.settled(() => expect(view.button(/Spot desk/)).toBeDefined());
  await act(async () => view.button(/Spot desk/)!.click());
  await view.settled(() => expect(view.text()).toContain("Running"));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await view.settled(() =>
    expect(view.container.querySelector('[data-testid="run-detail"]')!.textContent).toContain(
      "Done",
    ),
  );
  const calls = runs.detail.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(runs.detail.mock.calls.length).toBe(calls);
});

it("keeps the last loaded runs and offers a retry when a refresh fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runs.forTicket
    .mockResolvedValueOnce({ runs: [row({ status: "running" })], nextCursor: null })
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ runs: [row()], nextCursor: null });
  const view = await mounted();
  await view.settled(() => expect(view.text()).toContain("Running"));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await view.settled(() => expect(view.text()).toContain("Could not reach the server"));
  expect(view.container.querySelectorAll("li")).toHaveLength(1);
  await act(async () => view.button("Try again")!.click());
  await view.settled(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  expect(view.container.querySelector("li")!.textContent).toContain("Done");
});

it("tells apart runs by the same Bot in the same second, in the list, their names and detail", async () => {
  const first = "cmw5kh8h7000nc8qevfad2937";
  const second = "cmw5khff2000xc8qels24cshc";
  const sameSecond = "2026-11-06T22:49:32.000Z";
  runs.forTicket.mockResolvedValue({
    runs: [
      row({ runId: second, createdAt: sameSecond }),
      row({ runId: first, createdAt: sameSecond }),
    ],
    nextCursor: null,
  });
  runs.detail.mockImplementation(async ({ runId }: { runId: string }) =>
    detail({ runId, createdAt: sameSecond }),
  );
  const view = await mounted();
  await view.settled(() => expect(view.container.querySelectorAll("li button")).toHaveLength(2));
  const rows = [...view.container.querySelectorAll("li button")];
  const names = rows.map((b) => b.getAttribute("aria-label"));
  expect(names[0]).not.toBe(names[1]);
  expect(names[0]).toMatch(/^Run ls24cshc, Spot desk, Done, .*06:49:32/);
  expect(names[1]).toMatch(/^Run vfad2937, Spot desk, Done, /);
  expect(rows[0]!.textContent).toContain("#ls24cshc");
  expect(rows[1]!.textContent).toContain("#vfad2937");

  await act(async () => (rows[1] as HTMLButtonElement).click());
  await view.settled(() => expect(view.text()).toContain(first));
  const panel = view.container.querySelector('[data-testid="run-detail"]')!;
  expect(panel.getAttribute("aria-label")).toBe("Run vfad2937");
  expect(panel.textContent).toContain("#vfad2937");
  expect(panel.textContent).not.toContain(second);

  await switchLanguage("zh-CN");
  expect(panel.getAttribute("aria-label")).toBe("[zh-CN] Run vfad2937");
  await act(async () => view.button("All runs")!.click());
  const zhNames = [...view.container.querySelectorAll("li button")].map((b) =>
    b.getAttribute("aria-label"),
  );
  expect(zhNames[1]).toMatch(/^\[zh-CN\] Run vfad2937, /);
});

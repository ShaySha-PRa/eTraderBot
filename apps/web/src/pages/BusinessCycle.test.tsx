// @vitest-environment jsdom

import type { Bot, BusinessCycleState } from "@rakazo/contracts";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  businessCycle: { list: vi.fn(), get: vi.fn(), complete: vi.fn(), recovery: vi.fn() },
  boards: { subscribe: vi.fn() },
  businessSupervisor: {},
  tickets: { update: vi.fn() },
  trading: { desks: vi.fn(), desk: vi.fn() },
}));
/** The business the page opens in; null keeps drafts in memory only. */
const space = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => space.id,
}));
/** The interface language; switching it re-renders like the real provider does. */
const language = vi.hoisted(() => ({ locale: "en", listeners: new Set<() => void>() }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    (language.locale === "en" ? "" : `[${language.locale}] `) + String.raw(parts, ...values),
}));
vi.mock("@lingui/react/macro", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    language.listeners.add(listener);
    return () => language.listeners.delete(listener);
  };
  return {
    useLingui: () => {
      const locale = useSyncExternalStore(subscribe, () => language.locale);
      // Stand-in translation: other locales mark the source text with their code.
      const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
        (locale === "en" ? "" : `[${locale}] `) +
        parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
      return { t, i18n: { locale } };
    },
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

async function switchLanguage(locale: string) {
  await act(async () => {
    language.locale = locale;
    for (const listener of language.listeners) listener();
  });
}
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof UiWeb>()),
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { BusinessCyclePage } from "./BusinessCycle";

const rule = { version: "P25-synthetic-v1", stages: [] };
const cycles = [
  { id: "cycle-1", name: "Cycle one" },
  { id: "cycle-2", name: "Cycle two" },
];

function evidence(cycleId: string, kind: string) {
  return {
    id: `${cycleId}-${kind}`,
    cycleId,
    kind,
    streamKey: kind,
    revision: 1,
    status: "confirmed",
    origin: "synthetic",
    source: "fixture",
    sourceRecordId: kind,
    references: [],
    supersedesId: null,
    data: {},
  };
}

function task(
  ticketId: string,
  kind: string,
  status = "todo",
  assigneeBotId: string | null = "bot",
  extra: Record<string, unknown> = {},
) {
  return {
    ticketId,
    ref: ticketId.toUpperCase(),
    kind,
    assigneeBotId,
    status,
    dependsOn: [],
    requiredEvidence: [],
    blockers: [],
    result: null,
    ...extra,
  };
}

/** The server view of each cycle; tests change it to simulate refetches and completions. */
let server: Record<string, ReturnType<typeof task>[]>;
let extraEvidence: unknown[];
/** The shell's live Bot list handed to the page. */
let roster: unknown[];
function cycleState(cycleId: string) {
  return {
    cycle: { ...cycles.find((c) => c.id === cycleId), rule },
    evidence: [
      ...["contracts", "forecast", "asset"].map((kind) => evidence(cycleId, kind)),
      ...extraEvidence,
    ],
    tasks: server[cycleId]!.map((t) => ({ ...t })),
    settlement: null,
    reviewReady: false,
    blockers: [],
  } as unknown as BusinessCycleState;
}

/** The space's ticket-change stream; `event()` delivers one change. */
function boardStream() {
  let deliver: ((result: IteratorResult<{ ticketId?: string }>) => void) | undefined;
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<{ ticketId?: string }>>((resolve) => {
            deliver = resolve;
          }),
      }),
    },
    event: (ticketId: string) => deliver?.({ done: false, value: { ticketId } }),
  };
}
let live: ReturnType<typeof boardStream>;

/** The server's recovery reading for one task. */
function recovery(
  ticketId: string,
  assignee: { id: string; name: string; archivedAt: string | null } | null,
  candidates: { id: string; name: string }[] = [],
  canReplace = assignee === null || assignee.archivedAt !== null,
) {
  return {
    ticketId,
    cycleId: "cycle-1",
    requiredRole: "risk",
    assignee,
    canReplace,
    candidates: canReplace ? candidates : [],
  };
}

let client: QueryClient;
let view:
  | { container: HTMLElement; update: () => Promise<void>; cleanup: () => Promise<void> }
  | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  language.locale = "en";
  space.id = null;
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server = {
    "cycle-1": [task("contract", "contract_coverage"), task("risk", "risk_check")],
    "cycle-2": [task("contract-2", "contract_coverage")],
  };
  extraEvidence = [];
  api.tickets.update.mockReset();
  api.businessCycle.list.mockResolvedValue(cycles);
  api.businessCycle.get.mockImplementation(async ({ cycleId }: { cycleId: string }) =>
    cycleState(cycleId),
  );
  api.businessCycle.complete.mockReset();
  // By default the server reports each task's assignee as active, or none when unset.
  api.businessCycle.recovery.mockReset().mockImplementation(async ({ ticketId }) => {
    const found = Object.values(server)
      .flat()
      .find((t) => t.ticketId === ticketId);
    const id = found?.assigneeBotId ?? null;
    return recovery(ticketId, id ? { id, name: id, archivedAt: null } : null);
  });
  live = boardStream();
  api.boards.subscribe.mockReset().mockResolvedValue(live.stream);
  roster = [];
  api.trading.desks.mockResolvedValue([]);
});

afterEach(async () => {
  await view?.cleanup();
  view = undefined;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const paint = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BusinessCyclePage
            bot={{ id: "risk-bot", tradingRole: "risk" } as Bot}
            roster={roster as Bot[]}
          />
        </QueryClientProvider>,
      ),
    );
  await paint();
  await settle();
  await settle();
  view = {
    container,
    /** Re-render after the shell's roster changes. */
    async update() {
      await paint();
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return container;
}

type Field = "summary" | "disagreements" | "unresolved" | "proposal";

function field(ticketId: string, name: Field) {
  const el = view!.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-testid="cycle-task-${ticketId}"] [id$="-${ticketId}-${name}"]`,
  );
  if (!el) throw new Error(`missing ${ticketId} ${name}`);
  return el;
}

async function type(ticketId: string, name: Field, value: string) {
  const el = field(ticketId, name);
  const proto = Object.getPrototypeOf(el) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function values(ticketId: string) {
  return Object.fromEntries(
    (["summary", "disagreements", "unresolved", "proposal"] as const).map((name) => [
      name,
      field(ticketId, name).value,
    ]),
  );
}

async function submit(ticketId: string) {
  const button = [
    ...view!.container.querySelectorAll<HTMLButtonElement>(
      `[data-testid="cycle-task-${ticketId}"] button`,
    ),
  ].find((b) => b.textContent === "Record sourced result")!;
  await act(async () => button.click());
}

async function selectCycle(cycleId: string) {
  const select = view!.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Business cycle"]',
  )!;
  await act(async () => {
    select.value = cycleId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await settle();
}

async function fill(ticketId: string, prefix: string) {
  for (const name of ["summary", "disagreements", "unresolved", "proposal"] as const)
    await type(ticketId, name, `${prefix} ${name}`);
}

function draft(prefix: string) {
  return {
    summary: `${prefix} summary`,
    disagreements: `${prefix} disagreements`,
    unresolved: `${prefix} unresolved`,
    proposal: `${prefix} proposal`,
  };
}

const blank = { summary: "", disagreements: "", unresolved: "", proposal: "" };

it("keeps the contract and risk drafts apart and sends each with its own ticket and evidence", async () => {
  await render();
  await fill("contract", "Contract");
  await fill("risk", "Risk");
  expect(values("contract")).toEqual(draft("Contract"));
  expect(values("risk")).toEqual(draft("Risk"));

  api.businessCycle.complete.mockImplementation(async ({ ticketId }: { ticketId: string }) => {
    server["cycle-1"] = server["cycle-1"]!.map((t) =>
      t.ticketId === ticketId ? { ...t, status: "done" } : t,
    );
  });
  await submit("risk");
  await settle();

  expect(api.businessCycle.complete).toHaveBeenCalledTimes(1);
  expect(api.businessCycle.complete.mock.calls[0]![0]).toEqual({
    ticketId: "risk",
    expectedResultEvidenceId: null,
    result: {
      summary: "Risk summary",
      evidenceIds: ["cycle-1-contracts", "cycle-1-forecast", "cycle-1-asset"],
      disagreements: ["Risk disagreements"],
      unresolved: ["Risk unresolved"],
      improvementProposal: "Risk proposal",
    },
  });
  // The completed task drops its form; the other task keeps its unsent text.
  expect(view!.container.querySelector('[id$="-risk-summary"]')).toBeNull();
  expect(values("contract")).toEqual(draft("Contract"));

  await submit("contract");
  await settle();
  expect(api.businessCycle.complete.mock.calls[1]![0]).toMatchObject({
    ticketId: "contract",
    result: { summary: "Contract summary", evidenceIds: ["cycle-1-contracts"] },
  });
});

it("isolates drafts per cycle and restores them when switching back", async () => {
  await render();
  await fill("contract", "First");
  await selectCycle("cycle-2");
  expect(view!.container.querySelector('[id$="-contract-summary"]')).toBeNull();
  expect(values("contract-2")).toEqual(blank);
  await fill("contract-2", "Second");

  await selectCycle("cycle-1");
  expect(values("contract")).toEqual(draft("First"));
  expect(values("risk")).toEqual(blank);
  await selectCycle("cycle-2");
  expect(values("contract-2")).toEqual(draft("Second"));
});

it("keeps input after a failed submission and across refetches", async () => {
  await render();
  await fill("contract", "Contract");
  api.businessCycle.complete.mockRejectedValueOnce(new Error("Rejected by server"));
  await submit("contract");
  await settle();
  expect(view!.container.textContent).toContain("Rejected by server");
  expect(values("contract")).toEqual(draft("Contract"));

  await act(async () => client.invalidateQueries());
  await settle();
  expect(api.businessCycle.get.mock.calls.length).toBeGreaterThan(2);
  expect(values("contract")).toEqual(draft("Contract"));
});

it("keeps text and its evidence basis typed while the submission is in flight", async () => {
  server["cycle-1"]![0] = task("contract", "contract_coverage", "review", "bot", {
    resultEvidenceId: "result-1",
  });
  await render();
  await fill("contract", "Sent");
  let finish!: () => void;
  api.businessCycle.complete.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await submit("contract");
  await type("contract", "unresolved", "Typed later");
  await act(async () => finish());
  await settle();

  expect(api.businessCycle.complete.mock.calls[0]![0].result.unresolved).toEqual([
    "Sent unresolved",
  ]);
  // Server kept the task open (unresolved items need review), so the form stays.
  expect(values("contract")).toEqual({ ...blank, unresolved: "Typed later" });
  server["cycle-1"]![0] = task("contract", "contract_coverage", "review", "bot", {
    resultEvidenceId: "result-2",
  });
  await act(async () => client.invalidateQueries());
  await settle();
  await type("contract", "summary", "Still based on the earlier result");
  await submit("contract");
  expect(api.businessCycle.complete.mock.calls[1]![0].expectedResultEvidenceId).toBe("result-1");
});

it("marks a task whose assignee was removed", async () => {
  server["cycle-1"] = [task("contract", "contract_coverage", "todo", null)];
  const container = await render();
  // The assignee comes from the server's recovery reading, after the cycle loads.
  await settle();
  expect(container.querySelector('[data-testid="cycle-task-contract"] summary')?.textContent).toBe(
    "CONTRACT · Contract coverage · todo · Unassigned",
  );
});

function taskText(ticketId: string) {
  return view!.container.querySelector(`[data-testid="cycle-task-${ticketId}"]`)!.textContent;
}

it("separates starting an investigation from completing it", async () => {
  server["cycle-1"] = [
    task("review", "settlement_review", "todo", "bot", {
      startBlockers: [],
      blockers: ["evidence:settlement"],
    }),
    task("waiting", "settlement_review", "blocked", "bot", {
      startBlockers: ["evidence:metering"],
      blockers: ["evidence:metering", "evidence:settlement"],
    }),
    // Older servers send no start gaps; completion gaps then also gate starting.
    task("legacy", "risk_check", "blocked", "bot", { blockers: ["evidence:forecast"] }),
  ];
  await render();
  expect(taskText("review")).toContain(
    "Ready to investigate · Needed to complete: evidence:settlement",
  );
  expect(values("review")).toEqual(blank);
  expect(taskText("waiting")).toContain("Blocked: evidence:metering");
  expect(view!.container.querySelector('[id$="-waiting-summary"]')).toBeNull();
  expect(taskText("legacy")).toContain("Blocked: evidence:forecast");
  expect(view!.container.querySelector('[id$="-legacy-summary"]')).toBeNull();
});

it("records an investigation with unresolved items and keeps it in review", async () => {
  server["cycle-1"] = [
    task("review", "settlement_review", "todo", "bot", {
      startBlockers: [],
      blockers: ["evidence:settlement"],
    }),
  ];
  api.businessCycle.complete.mockImplementation(
    async ({ result }: { result: Record<string, unknown> }) => {
      server["cycle-1"] = [
        task("review", "settlement_review", "review", "bot", {
          startBlockers: [],
          blockers: ["evidence:settlement"],
          result,
        }),
      ];
    },
  );
  await render();
  await type("review", "summary", "Bill differs by 100 CNY");
  await type("review", "unresolved", "Bill correction pending");
  await submit("review");
  await settle();
  expect(api.businessCycle.complete.mock.calls[0]![0].result).toMatchObject({
    summary: "Bill differs by 100 CNY",
    unresolved: ["Bill correction pending"],
  });
  expect(taskText("review")).toContain("REVIEW · Settlement review · review");
  expect(taskText("review")).not.toContain("· done");
  expect(taskText("review")).toContain("Unresolved: Bill correction pending");
  expect(taskText("review")).toContain("Needed to complete: evidence:settlement");
  // Still open: the form stays for a later result.
  expect(values("review")).toEqual(blank);
});

it("restores a missing assignee with a server-listed specialist and keeps the result", async () => {
  const result = {
    summary: "Earlier risk result",
    evidenceIds: ["cycle-1-contracts"],
    disagreements: [],
    unresolved: ["Pending"],
    improvementProposal: null,
  };
  server["cycle-1"] = [task("risk", "risk_check", "review", null, { result })];
  // The shell roster holds more Bots; only the server's candidates are offered.
  roster = [
    { id: "risk-2", name: "Risk two", tradingRole: "risk", archivedAt: null },
    { id: "risk-3", name: "Risk three", tradingRole: "risk", archivedAt: null },
    { id: "chief", name: "Chief", businessSupervisor: true, tradingRole: null, archivedAt: null },
  ];
  api.businessCycle.recovery.mockResolvedValue(
    recovery("risk", null, [{ id: "risk-2", name: "Risk two" }]),
  );
  api.tickets.update.mockImplementation(async ({ assigneeBotId }: { assigneeBotId: string }) => {
    server["cycle-1"] = [task("risk", "risk_check", "todo", assigneeBotId, { result })];
  });
  await render();
  await settle();
  expect(taskText("risk")).toContain("RISK · Risk check · review · Unassigned");
  expect(taskText("risk")).toContain("No assignee");
  const select = replacementSelect("risk")!;
  expect([...select.options].map((o) => o.textContent)).toEqual(["Risk two"]);
  await act(async () => restoreButton("risk")!.click());
  await settle();
  expect(api.tickets.update).toHaveBeenCalledWith({ id: "risk", assigneeBotId: "risk-2" });
  // Same ticket and cycle; the earlier result and unresolved items stay.
  expect(taskText("risk")).toContain("RISK · Risk check · todo · Risk two");
  expect(taskText("risk")).toContain("Earlier risk result");
  expect(taskText("risk")).toContain("Pending");
  expect(replacementSelect("risk")).toBeNull();
});

it("calls an assignee archived only when the server says so", async () => {
  server["cycle-1"] = [
    task("risk", "risk_check", "todo", "gone", { blockers: ["assignee:archived"] }),
    task("contract", "contract_coverage", "todo", "elsewhere"),
  ];
  api.businessCycle.recovery.mockImplementation(async ({ ticketId }: { ticketId: string }) =>
    ticketId === "risk"
      ? recovery("risk", { id: "gone", name: "Old risk", archivedAt: "2026-11-07T00:00:00Z" }, [
          { id: "risk-2", name: "Risk two" },
        ])
      : // Absent from the shell roster, but the server says this assignee is active.
        recovery("contract", { id: "elsewhere", name: "Contract desk", archivedAt: null }),
  );
  await render();
  await settle();
  expect(taskText("risk")).toContain("RISK · Risk check · todo · Old risk (Archived)");
  expect(taskText("risk")).toContain("Assignee archived: Old risk");
  expect(replacementSelect("risk")).not.toBeNull();
  expect(taskText("contract")).toContain("CONTRACT · Contract coverage · todo · Contract desk");
  expect(taskText("contract")).not.toContain("Archived");
  expect(replacementSelect("contract")).toBeNull();
});

it("does not allow a restore without an eligible Bot", async () => {
  server["cycle-1"] = [task("risk", "risk_check", "todo", null)];
  api.businessCycle.recovery.mockResolvedValue(recovery("risk", null, []));
  await render();
  await settle();
  expect(taskText("risk")).toContain("No eligible Bot for this role yet");
  expect(restoreButton("risk")).toBeUndefined();
});

it("shows a refused restore beside the task in the interface language and keeps the choice", async () => {
  server["cycle-1"] = [task("risk", "risk_check", "todo", null)];
  api.businessCycle.recovery.mockResolvedValue(
    recovery("risk", null, [{ id: "risk-2", name: "Risk two" }]),
  );
  api.tickets.update.mockRejectedValueOnce(
    Object.assign(new Error("Replacement must be an active same-role Bot"), {
      code: "FORBIDDEN",
      data: { reason: "FORBIDDEN" },
    }),
  );
  await render();
  await settle();
  await act(async () => restoreButton("risk")!.click());
  await settle();
  expect(taskAlert("risk")?.textContent).toBe("This Bot can't take over this task");
  expect(taskText("risk")).not.toContain("Replacement must be");
  expect(pageAlerts()).toHaveLength(0);
  expect(replacementSelect("risk")?.value).toBe("risk-2");
  await switchLanguage("zh-CN");
  expect(taskAlert("risk")?.textContent).toBe("[zh-CN] This Bot can't take over this task");
});

it("keeps a restored task blocked while its prerequisite evidence is missing", async () => {
  server["cycle-1"] = [
    task("spot", "spot_analysis", "blocked", null, { startBlockers: ["assignee:missing", "risk"] }),
  ];
  api.businessCycle.recovery.mockResolvedValue(
    recovery("spot", null, [{ id: "spot-2", name: "Spot two" }]),
  );
  roster = [{ id: "spot-2", name: "Spot two", tradingRole: "spot", archivedAt: null }];
  api.tickets.update.mockImplementation(async () => {
    server["cycle-1"] = [
      task("spot", "spot_analysis", "blocked", "spot-2", { startBlockers: ["risk"] }),
    ];
  });
  await render();
  await settle();
  await act(async () => restoreButton("spot")!.click());
  await settle();
  expect(taskText("spot")).toContain("SPOT · Spot analysis · blocked · Spot two");
  expect(taskText("spot")).toContain("Blocked: risk");
});

it("refreshes the cycle and its assignee when another screen archives the Bot", async () => {
  server["cycle-1"] = [task("risk", "risk_check", "todo", "risk-1")];
  roster = [{ id: "risk-1", name: "Risk one", tradingRole: "risk", archivedAt: null }];
  await render();
  expect(taskText("risk")).toContain("RISK · Risk check · todo · Risk one");
  expect(api.businessCycle.recovery).not.toHaveBeenCalled();

  // Archived elsewhere: the server marks the task, and the board stream announces the change.
  server["cycle-1"] = [
    task("risk", "risk_check", "blocked", "risk-1", { startBlockers: ["assignee:archived"] }),
  ];
  api.businessCycle.recovery.mockResolvedValue(
    recovery("risk", { id: "risk-1", name: "Risk one", archivedAt: "2026-11-07T00:00:00Z" }, [
      { id: "risk-2", name: "Risk two" },
    ]),
  );
  const reads = api.businessCycle.get.mock.calls.length;
  await act(async () => live.event("risk"));
  await settle();
  await settle();
  expect(api.businessCycle.get.mock.calls.length).toBeGreaterThan(reads);
  expect(taskText("risk")).toContain("RISK · Risk check · blocked · Risk one (Archived)");
  expect(taskText("risk")).toContain("Blocked: Assignee archived");
  expect(taskText("risk")).not.toContain("assignee:archived");
  expect([...replacementSelect("risk")!.options].map((o) => o.textContent)).toEqual(["Risk two"]);
});

function replacementSelect(ticketId: string) {
  return view!.container.querySelector<HTMLSelectElement>(
    `[data-testid="cycle-task-${ticketId}"] select[aria-label="Replacement"]`,
  );
}

function restoreButton(ticketId: string) {
  return [
    ...view!.container.querySelectorAll<HTMLButtonElement>(
      `[data-testid="cycle-task-${ticketId}"] button`,
    ),
  ].find((b) => b.textContent === "Restore");
}

it("shows each submission stage as its own evidence", async () => {
  extraEvidence = [
    {
      ...evidence("cycle-1", "submission"),
      id: "da",
      data: { stage: "day_ahead", status: "accepted" },
    },
    {
      ...evidence("cycle-1", "submission"),
      id: "mlt",
      streamKey: "submission:mid_long_term",
      data: { stage: "mid_long_term", status: "accepted" },
    },
  ];
  await render();
  const summary = (key: string) =>
    view!.container.querySelector(`[data-testid="evidence-${key}"] summary`)?.textContent;
  expect(summary("submission")).toContain("Submission receipt · day_ahead · v1");
  expect(summary("submission:mid_long_term")).toContain("Submission receipt · mid_long_term · v1");
});

function taskAlert(ticketId: string) {
  return view!.container.querySelector(`[data-testid="cycle-task-${ticketId}"] [role="alert"]`);
}

/** Page-level alerts sit outside every task form. */
function pageAlerts() {
  return [...view!.container.querySelectorAll('[role="alert"]')].filter(
    (alert) => !alert.closest('[data-testid^="cycle-task-"]'),
  );
}

it("names the field and limit beside the form when a result is too long", async () => {
  await render();
  await fill("risk", "Risk");
  await type("contract", "summary", "Contract summary");
  await type("contract", "disagreements", "x".repeat(2001));
  await submit("contract");
  await settle();

  expect(api.businessCycle.complete).not.toHaveBeenCalled();
  const alert = taskAlert("contract")!;
  expect(alert.textContent).toBe("Disagreements must be 2000 characters or fewer");
  const tooLong = field("contract", "disagreements");
  expect(tooLong.getAttribute("aria-invalid")).toBe("true");
  expect(tooLong.getAttribute("aria-describedby")).toBe(alert.id);
  expect(field("contract", "summary").getAttribute("aria-invalid")).toBeNull();
  expect(tooLong.value).toHaveLength(2001);
  expect(values("risk")).toEqual(draft("Risk"));
  expect(taskAlert("risk")).toBeNull();
  expect(pageAlerts()).toHaveLength(0);

  // Fixing the field retires the message; the boundary value is accepted and sent.
  await type("contract", "disagreements", "x".repeat(2000));
  expect(taskAlert("contract")).toBeNull();
  await submit("contract");
  await settle();
  expect(api.businessCycle.complete.mock.calls[0]![0].result.disagreements[0]).toHaveLength(2000);
});

it("maps a server validation issue to its field and keeps the draft", async () => {
  await render();
  await fill("contract", "Contract");
  api.businessCycle.complete.mockRejectedValueOnce(
    Object.assign(new Error("Input validation failed"), {
      code: "BAD_REQUEST",
      data: {
        issues: [{ code: "too_big", maximum: 8000, path: ["result", "improvementProposal"] }],
      },
    }),
  );
  await submit("contract");
  await settle();
  expect(taskAlert("contract")?.textContent).toBe(
    "Improvement proposal (not enabled) must be 8000 characters or fewer",
  );
  expect(field("contract", "proposal").getAttribute("aria-invalid")).toBe("true");
  expect(values("contract")).toEqual(draft("Contract"));
  expect(pageAlerts()).toHaveLength(0);
});

it("shows a server refusal in the task form", async () => {
  await render();
  await fill("contract", "Contract");
  api.businessCycle.complete.mockRejectedValueOnce(
    new Error("Settlement evidence must be confirmed before completion"),
  );
  await submit("contract");
  await settle();
  const alert = taskAlert("contract")!;
  expect(alert.textContent).toBe("Settlement evidence must be confirmed before completion");
  // A general failure is described for every input in the form.
  expect(field("contract", "summary").getAttribute("aria-describedby")).toBe(alert.id);
  expect(field("contract", "summary").getAttribute("aria-invalid")).toBeNull();
  expect(values("contract")).toEqual(draft("Contract"));
  expect(taskAlert("risk")).toBeNull();
  expect(pageAlerts()).toHaveLength(0);
});

it("shows coded business refusals in the interface language, not server text", async () => {
  await render();
  await fill("contract", "Contract");
  const refusal = (reason: string, message: string) =>
    Object.assign(new Error(message), { code: "BAD_REQUEST", data: { reason } });
  api.businessCycle.complete.mockRejectedValueOnce(
    refusal("MISSING_EVIDENCE", "Required evidence or predecessor result is still missing"),
  );
  await submit("contract");
  await settle();
  expect(taskAlert("contract")?.textContent).toBe(
    "Required evidence or a prerequisite result is still missing",
  );
  expect(values("contract")).toEqual(draft("Contract"));

  api.businessCycle.complete.mockRejectedValueOnce(
    refusal("STALE_DATA", "Result references missing, foreign or superseded evidence"),
  );
  await submit("contract");
  await settle();
  expect(taskAlert("contract")?.textContent).toBe(
    "Evidence changed. Check the latest versions and submit again",
  );

  // A code this page does not know falls back to translated generic copy.
  api.businessCycle.complete.mockRejectedValueOnce(refusal("NEW_RULE", "Some new server rule"));
  await submit("contract");
  await settle();
  expect(taskAlert("contract")?.textContent).toBe("Could not continue");
  expect(values("contract")).toEqual(draft("Contract"));
  expect(pageAlerts()).toHaveLength(0);
});

it("keeps the draft's evidence and result version across refreshes until the user reviews the latest result", async () => {
  server["cycle-1"] = [
    task("contract", "contract_coverage", "review", "bot", { resultEvidenceId: "result-1" }),
  ];
  await render();
  await fill("contract", "Draft");
  server["cycle-1"] = [
    task("contract", "contract_coverage", "review", "bot", {
      resultEvidenceId: "result-2",
      result: {
        summary: "New human findings",
        unresolved: ["Contract explanation needed"],
        disagreements: [],
        evidenceIds: ["cycle-1-contracts"],
        improvementProposal: null,
      },
    }),
  ];
  await act(async () => client.invalidateQueries());
  await settle();
  api.businessCycle.complete.mockRejectedValueOnce({ data: { reason: "STALE_DATA" } });
  await submit("contract");
  await settle();
  expect(api.businessCycle.complete.mock.calls[0]![0].expectedResultEvidenceId).toBe("result-1");
  expect(values("contract")).toEqual(draft("Draft"));
  // The shown conflict follows the interface language.
  const alertText = () =>
    view!.container.querySelector('[data-testid="cycle-task-contract"] [role="alert"]')
      ?.textContent;
  expect(alertText()).toBe("Evidence changed. Check the latest versions and submit again");
  await switchLanguage("zh-CN");
  expect(alertText()).toBe("[zh-CN] Evidence changed. Check the latest versions and submit again");
  await switchLanguage("en");
  const useLatest = [...view!.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Use latest version",
  )!;
  expect(useLatest).toBeDefined();
  await act(async () => useLatest.click());
  await submit("contract");
  expect(api.businessCycle.complete.mock.calls[1]![0].expectedResultEvidenceId).toBe("result-2");
});

it("says access was removed on a real 401, in the interface language, and keeps the draft", async () => {
  space.id = "space-a";
  await render();
  await fill("contract", "Contract");
  api.businessCycle.complete.mockRejectedValueOnce(
    Object.assign(new Error("Unauthorized"), { code: "UNAUTHORIZED", status: 401 }),
  );
  await submit("contract");
  await settle();
  expect(taskAlert("contract")?.textContent).toBe("You no longer have access to this business");
  expect(view!.container.textContent).not.toContain("Unauthorized");
  expect(values("contract")).toEqual(draft("Contract"));
  await switchLanguage("zh-CN");
  expect(taskAlert("contract")?.textContent).toBe(
    "[zh-CN] You no longer have access to this business",
  );
});

it("restores an unsent draft and its version after a reload, without sending it", async () => {
  space.id = "space-a";
  server["cycle-1"]![0] = task("contract", "contract_coverage", "review", "bot", {
    resultEvidenceId: "result-1",
  });
  await render();
  await fill("contract", "Kept");
  await view!.cleanup();
  view = undefined;
  // The server moved on while the page was gone; the restored draft keeps its starting version.
  server["cycle-1"]![0] = task("contract", "contract_coverage", "review", "bot", {
    resultEvidenceId: "result-2",
  });

  await render();
  expect(values("contract")).toEqual(draft("Kept"));
  await settle();
  expect(api.businessCycle.complete).not.toHaveBeenCalled();
  await submit("contract");
  await settle();
  expect(api.businessCycle.complete.mock.calls[0]![0]).toMatchObject({
    ticketId: "contract",
    expectedResultEvidenceId: "result-1",
  });
});

it("never shows one business's drafts in another, and forgets a draft once it is sent", async () => {
  space.id = "space-a";
  await render();
  await fill("contract", "Business A");
  await view!.cleanup();
  view = undefined;

  space.id = "space-b";
  await render();
  expect(values("contract")).toEqual(blank);
  await view!.cleanup();
  view = undefined;

  space.id = "space-a";
  await render();
  expect(values("contract")).toEqual(draft("Business A"));
  api.businessCycle.complete.mockResolvedValueOnce(undefined);
  await submit("contract");
  await settle();
  expect(localStorage.getItem("rakazo.businessResultDrafts.space-a")).toBeNull();
});

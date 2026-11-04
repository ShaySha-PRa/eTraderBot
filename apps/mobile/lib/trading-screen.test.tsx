// @vitest-environment jsdom
import type { RpcOutput } from "@rakazo/contracts";
import { createTradingSimulationSnapshot, simulateTradingExecution } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import TradingScreen from "../app/trading";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
  t: (value: string) => value,
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));
vi.mock("react-native", () => ({
  View: mocks.element("div"),
  Text: mocks.element("span"),
  ScrollView: mocks.element("div"),
  ActivityIndicator: () => null,
  Alert: { alert: mocks.alert },
  StyleSheet: { create: <T,>(style: T) => style },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useFocusEffect: (fn: () => undefined | (() => void)) => useEffect(fn, [fn]),
}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("../components/confirm-identity", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: mocks.confirm,
    identityDialog: null,
  }),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: mocks.element("section"),
  SettingsRow: ({
    title,
    detail,
    value,
    onPress,
    disabled,
  }: {
    title: string;
    detail?: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    createElement(onPress ? "button" : "div", { onClick: onPress, disabled }, title, detail, value),
}));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function fixture(): RpcOutput<"trading/desk"> {
  const snapshot = createTradingSimulationSnapshot(
    {
      subjectId: "synthetic",
      subjectKind: "retailer",
      accountId: "synthetic-account",
      region: "CN-SD",
      marketId: "synthetic",
      productId: "energy",
      stage: "day_ahead",
      environment: "simulation",
    },
    new Date("2035-01-01T00:00:00Z"),
  );
  const createdAt = snapshot.source.observedAt;
  return {
    simulationScenario: "immediate_fill",
    desk: {
      id: "desk",
      spaceId: "space",
      ownerUserId: "owner",
      algorithmApproverUserId: "owner",
      tradeApproverUserId: "owner",
      scope: { ...snapshot.scope, environment: "simulation" },
      createdAt,
    },
    versions: [
      {
        id: "version",
        deskId: "desk",
        algorithmVersionId: "engine",
        artifactHash: "a".repeat(64),
        artifact: "fixed source",
        parameters: { margin: "0" },
        validation: {
          kind: "deterministic_constraints",
          analysisId: "analysis",
          decisionHash: "b".repeat(64),
        },
        status: "pending",
        approvedByUserId: null,
        approvedAt: null,
        createdAt,
      },
    ],
    intents: [
      {
        id: "intent",
        deskId: "desk",
        botId: null,
        versionId: "version",
        analysisId: "analysis",
        intent: {
          intentId: "intent",
          intentHash: "c".repeat(64),
          scope: snapshot.scope,
          algorithmVersionId: "engine",
          snapshotId: snapshot.snapshotId,
          ruleVersion: snapshot.rules.version,
          lines: [
            {
              start: snapshot.input.intervals[0]!.start,
              end: snapshot.input.intervals[0]!.end,
              side: "buy",
              energyMwh: "3",
              limitPrice: "300",
            },
          ],
          expiresAt: "2035-01-01T00:30:00Z",
        },
        snapshot,
        parameters: { margin: "0" },
        grossNotionalCny: "900",
        approvedByUserId: null,
        approvedAt: null,
        createdAt,
      },
    ],
    grants: [],
    bindings: [],
    executions: [],
    audit: [],
  };
}
async function render(
  userId = "owner",
  empty = false,
  learning: RpcOutput<"trading/learningState"> = {
    plans: [],
    sources: [],
    sessions: [],
    reports: [],
  },
  state = fixture(),
) {
  mocks.rpc.mockImplementation(async (path: string) =>
    path === "me"
      ? { userId }
      : path === "trading/desks"
        ? empty
          ? []
          : [state.desk]
        : path === "trading/desk"
          ? state
          : path === "trading/learningState"
            ? learning
            : {},
  );
  mocks.confirm.mockImplementation(async (action: () => Promise<unknown>) => action());
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TradingScreen));
  });
  return { container, state };
}
it("starts scoped learning on mobile without granting algorithm or trade approval", async () => {
  const { container } = await render("owner", false, {
    sources: [],
    reports: [],
    sessions: [],
    plans: [
      {
        id: "plan",
        deskId: "desk",
        botId: "bot",
        routineId: "routine",
        baselineMargin: "0",
        schedule: { time: "02:00", timezone: "Asia/Shanghai", active: true },
        nextRunAt: null,
      },
    ],
  });
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Learn now",
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  expect(mocks.rpc).toHaveBeenCalledWith("trading/startLearning", {
    deskId: "desk",
    botId: "bot",
    clientRequestId: expect.any(String),
  });
  expect(
    mocks.rpc.mock.calls.some(
      ([path]) => path === "trading/approveAlgorithm" || path === "trading/approveIntent",
    ),
  ).toBe(false);
});
it("requires explicit confirmation and uses immutable evidence for a mobile approval", async () => {
  const { container, state } = await render();
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Approve algorithm",
  )!;
  expect(button).toBeTruthy();
  await act(async () => {
    button.click();
  });
  expect(mocks.confirm).not.toHaveBeenCalled();
  const choices = mocks.alert.mock.lastCall?.[2] as { text: string; onPress?: () => void }[];
  await act(async () => {
    choices.find((choice) => choice.text === "Continue")!.onPress?.();
  });
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.rpc).toHaveBeenCalledWith("trading/approveAlgorithm", {
    deskId: "desk",
    versionId: "version",
    expectedArtifactHash: state.versions[0]!.artifactHash,
  });
});
it("keeps approval controls hidden from a viewer without the assigned business roles", async () => {
  const { container } = await render("viewer");
  expect(container.textContent).toContain("900 CNY");
  expect(
    [...container.querySelectorAll("button")].some(
      (node) => node.textContent === "Approve algorithm" || node.textContent === "Approve trade",
    ),
  ).toBe(false);
});
it("shows a useful empty state without inventing a business scope", async () => {
  const { container } = await render("owner", true);
  expect(container.textContent).toContain("No trading scopes");
  expect(container.textContent).toContain("Open this Bot on web to configure its business scope.");
  expect(container.textContent).not.toContain("900 CNY");
});

it.each(["owner", "viewer"])(
  "shows current receipt and restricts mobile cancellation for %s",
  async (userId) => {
    const state = fixture();
    const receipt = simulateTradingExecution({
      intent: state.intents[0]!.intent,
      executionId: "execution",
      clientRequestId: "request",
      scenario: "timeout",
      energyStep: "0.01",
      now: new Date("2035-01-01T00:00:00Z"),
    });
    state.executions.push({
      id: "execution",
      deskId: "desk",
      intentId: "intent",
      grantId: null,
      clientRequestId: "request",
      receipt,
      receipts: [receipt],
      createdAt: "2035-01-01T00:00:00Z",
    });
    const { container } = await render(userId, false, undefined, state);
    expect(container.textContent).toContain("Result uncertain");
    const buttons = [...container.querySelectorAll("button")];
    await act(async () => buttons.find((node) => node.textContent === "Reconcile order")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith("trading/reconcileExecution", {
      deskId: "desk",
      executionId: "execution",
      expectedSequence: 1,
    });
    const cancel = buttons.find((node) => node.textContent === "Cancel order");
    if (userId === "viewer") {
      expect(cancel).toBeUndefined();
      return;
    }
    await act(async () => cancel!.click());
    expect(mocks.rpc.mock.calls.some(([path]) => path === "trading/cancelSimulation")).toBe(false);
    const choices = mocks.alert.mock.lastCall?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => choices.find((choice) => choice.text === "Continue")!.onPress?.());
    expect(mocks.rpc).toHaveBeenCalledWith("trading/cancelSimulation", {
      deskId: "desk",
      executionId: "execution",
      clientRequestId: expect.any(String),
    });
  },
);

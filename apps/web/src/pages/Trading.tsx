import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  TradingWorkspace as BusinessScope,
  RpcInput,
  RpcOutput,
  TradingAnalysis,
  TradingDesk,
  TradingStoredIntent,
} from "@rakazo/contracts";
import { TradingScopeSchema, TradingSimulationScenarioSchema } from "@rakazo/contracts";
import { formatTradingInstant, tradingExecutionTerminal } from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent, ReactElement } from "react";
import { cloneElement, useId, useRef, useState } from "react";
import { useQueryUserId, useSpaceQueries } from "../lib/query";
import { useTradingActions } from "../lib/trading-actions";
import { errorText } from "../lib/user-error";
import { TradingLearning } from "./TradingLearning";

type State = RpcOutput<"trading/desk">;
type Bots = RpcOutput<"bots/list">;

function useTradingNames() {
  const { t } = useLingui();
  return {
    status: {
      accepted: t`Accepted`,
      partially_filled: t`Partially filled`,
      filled: t`Filled`,
      rejected: t`Rejected`,
      cancelled: t`Cancelled`,
      unknown: t`Result uncertain`,
    },
    scenario: {
      immediate_fill: t`Immediate fill`,
      partial_fill: t`Partial fill`,
      timeout: t`Submission timeout`,
      rejected: t`Rejection`,
      pending: t`Pending order`,
      cancel_timeout: t`Cancellation timeout`,
      unavailable: t`Venue unavailable`,
    },
    kind: { retailer: t`Retailer`, generator: t`Generator`, storage: t`Storage` },
    stage: {
      mid_long_term: t`Mid / long term`,
      day_ahead: t`Day ahead`,
      intraday: t`Intraday`,
      realtime: t`Real time`,
    },
    role: { mid_long_term: t`Mid / long term`, spot: t`Spot`, risk: t`Risk`, review: t`Review` },
  };
}

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

export function TradingPage({
  bot,
  view,
  businessScope,
  onChooseScope,
}: {
  bot: Bot;
  view: "trading" | "learning";
  businessScope?: BusinessScope;
  onChooseScope: () => void;
}) {
  const { t } = useLingui();
  const names = useTradingNames();
  const queries = useSpaceQueries();
  const userId = useQueryUserId();
  const list = useQuery(queries.trading.desks.queryOptions({ input: { botId: bot.id } }));
  const available = useQuery(queries.trading.desks.queryOptions({ input: {} }));
  const bots = useQuery(queries.bots.list.queryOptions());
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const [selected, setSelected] = useState("");
  const desks = [
    ...(list.data ?? []),
    ...(available.data ?? []).filter((row) => row.ownerUserId !== userId),
  ]
    .filter((row) => businessScope?.deskIds.includes(row.id))
    .sort(
      (a, b) =>
        TradingScopeSchema.shape.stage.options.indexOf(a.scope.stage) -
        TradingScopeSchema.shape.stage.options.indexOf(b.scope.stage),
    );
  const desk = desks.find((row) => row.id === selected) ?? desks[0];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="flex-1 font-medium">
          {view === "learning"
            ? t`Learning`
            : bot.tradingRole === "risk"
              ? t`Risk review`
              : bot.tradingRole === "review"
                ? t`Trading review`
                : t`Simulation trading`}
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-6 p-4 sm:p-6">
          {error || list.error || available.error || bots.error ? (
            <p role="alert" className="text-sm text-destructive">
              {error || errorText(list.error ?? available.error ?? bots.error)}
            </p>
          ) : null}
          {!businessScope ? (
            <div className="grid justify-items-start gap-3">
              <p className="text-sm text-muted-foreground">
                <Trans>Select a business scope in the sidebar first.</Trans>
              </p>
              <Button variant="outline" onClick={onChooseScope}>
                <Trans>Choose business scope</Trans>
              </Button>
            </div>
          ) : list.isPending ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : !desk && !list.isError ? (
            <Button
              className="justify-self-start"
              disabled={pending || businessScope.ownerUserId !== userId}
              onClick={() =>
                void act(
                  () =>
                    api.trading.connectWorkspaceBot({
                      workspaceId: businessScope.id,
                      botId: bot.id,
                    }),
                  true,
                )
              }
            >
              <Trans>Add bot to business scope</Trans>
            </Button>
          ) : null}
          {desk ? (
            <>
              {desk.ownerUserId !== userId ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>Human approval · this bot has no access to this scope</Trans>
                </p>
              ) : null}
              <Field label={t`Trading stage`}>
                <NativeSelect value={desk.id} onChange={(event) => setSelected(event.target.value)}>
                  {desks.map((row) => (
                    <NativeSelectOption key={row.id} value={row.id}>
                      {names.stage[row.scope.stage]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {desk.ownerUserId === userId ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    <Trans>Manage trading stage</Trans>
                  </summary>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        () => api.trading.unbindBot({ deskId: desk.id, botId: bot.id }),
                        true,
                      )
                    }
                  >
                    <Trans>Disconnect scope</Trans>
                  </Button>
                </details>
              ) : null}
              {view === "learning" ? (
                <TradingLearning
                  key={desk.id}
                  deskId={desk.id}
                  botId={bot.id}
                  owner={userId === desk.ownerUserId}
                  bots={bots.data ?? []}
                  api={api}
                  act={act}
                  pending={pending}
                />
              ) : (
                <TradingWorkspace
                  key={desk.id}
                  desk={desk}
                  userId={userId}
                  bots={bots.data ?? []}
                  bot={bot}
                />
              )}
            </>
          ) : null}
        </div>
      </main>
      {identityDialog}
    </div>
  );
}

/** Assigned human approvals do not require, or create, a Bot binding. */
export function TradingApprovals({ businessScope }: { businessScope: BusinessScope }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const userId = useQueryUserId();
  const available = useQuery(queries.trading.desks.queryOptions({ input: {} }));
  const [selected, setSelected] = useState("");
  const names = useTradingNames();
  const desks = available.data?.filter((row) => businessScope.deskIds.includes(row.id)) ?? [];
  const desk = desks.find((row) => row.id === selected) ?? desks[0];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-16">
      <div className="mx-auto grid max-w-5xl gap-5 p-6">
        <h1 className="font-medium">
          <Trans>Human approvals</Trans> · {businessScope.name}
        </h1>
        {available.isError ? (
          <p role="alert" className="text-destructive">
            {errorText(available.error)}
          </p>
        ) : null}
        {desk ? (
          <>
            <Field label={t`Trading stage`}>
              <NativeSelect value={desk.id} onChange={(event) => setSelected(event.target.value)}>
                {desks.map((row) => (
                  <NativeSelectOption key={row.id} value={row.id}>
                    {names.stage[row.scope.stage]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <TradingWorkspace key={desk.id} desk={desk} userId={userId} bots={[]} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No trading stages configured yet.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

function TradingWorkspace({
  desk,
  userId,
  bots,
  bot,
}: {
  bot?: Bot;
  desk: TradingDesk;
  userId: string | null;
  bots: Bots;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const state = useQuery({
    ...queries.trading.desk.queryOptions({ input: { deskId: desk.id } }),
    refetchInterval: 5000,
  });
  const history = useQuery(queries.trading.history.queryOptions({ input: { limit: 100 } }));
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const [margin, setMargin] = useState("0");
  const latest = history.data?.find(
    (analysis) => JSON.stringify(analysis.snapshot.scope) === JSON.stringify(desk.scope),
  );
  const names = useTradingNames();
  const canTrade = bot?.tradingRole === "spot" || bot?.tradingRole === "mid_long_term";
  const owner = userId === desk.ownerUserId && canTrade;
  const algorithmApprover = userId === desk.algorithmApproverUserId;
  const tradeAuthorizer = userId === desk.tradeApproverUserId;
  const data = state.data;
  const versions = data?.versions ?? [];
  const approved = versions.filter((version) => version.status === "approved");
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const botId = String(form.get("botId") ?? "");
    await act(
      () =>
        api.trading.createGrant({
          deskId: desk.id,
          versionId: String(form.get("versionId")),
          perTradeLimitCny: String(form.get("perTradeLimitCny")),
          cumulativeLimitCny: String(form.get("cumulativeLimitCny")),
          allowCancellation: form.get("allowCancellation") === "true",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          ...(botId ? { botId } : {}),
        }),
      true,
    );
  }
  return (
    <div className="grid gap-6">
      {error || state.error || history.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error || errorText(state.error ?? history.error)}
        </p>
      ) : null}
      <section className="grid gap-3 rounded-xl border p-4">
        <SectionHeading>
          <Trans>Candidate analysis</Trans>
        </SectionHeading>
        <p className="text-sm text-muted-foreground">
          {desk.scope.accountId} · {desk.scope.marketId} · <Trans>Synthetic data</Trans>
        </p>
        {owner ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t`Price margin (CNY/MWh)`}>
              <Input
                value={margin}
                onChange={(event) => setMargin(event.target.value)}
                className="w-40"
                inputMode="decimal"
              />
            </Field>
            <Button
              disabled={pending}
              onClick={() =>
                void act(() => api.trading.simulate({ scope: desk.scope, parameters: { margin } }))
              }
            >
              <Trans>Run analysis</Trans>
            </Button>
          </div>
        ) : null}
        {latest ? (
          <>
            <DecisionSummary analysis={latest} />
            {owner ? (
              <Button
                variant="outline"
                disabled={pending}
                className="justify-self-start"
                onClick={() =>
                  void act(() =>
                    api.trading.prepareIntent({
                      deskId: desk.id,
                      analysisId: latest.id,
                      expiresAt: new Date(
                        Math.min(
                          Date.now() + 900_000,
                          Date.parse(latest.snapshot.source.validUntil),
                          Date.parse(latest.snapshot.rules.source.validUntil),
                        ),
                      ).toISOString(),
                    }),
                  )
                }
              >
                <Trans>Prepare intent</Trans>
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No analysis yet</Trans>
          </p>
        )}
      </section>
      {owner && data ? (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer text-sm">
            <Trans>Simulation scenario</Trans>
          </summary>
          <div className="mt-3">
            <Field label={t`New orders`}>
              <NativeSelect
                value={data.simulationScenario}
                disabled={pending}
                onChange={(event) => {
                  const scenario = TradingSimulationScenarioSchema.parse(event.target.value);
                  void act(
                    () => api.trading.configureSimulation({ deskId: desk.id, scenario }),
                    true,
                  );
                }}
              >
                {TradingSimulationScenarioSchema.options.map((scenario) => (
                  <NativeSelectOption key={scenario} value={scenario}>
                    {names.scenario[scenario]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
        </details>
      ) : null}
      {versions.length ? (
        <section className="grid gap-3">
          <SectionHeading>
            <Trans>Algorithm versions</Trans>
          </SectionHeading>
          {versions.map((version) => (
            <article key={version.id} className="grid gap-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">
                  {t`Margin`} {version.parameters.margin}
                </span>
                <span className="text-sm text-muted-foreground">
                  {version.status === "pending"
                    ? t`Pending`
                    : version.status === "approved"
                      ? t`Approved`
                      : t`Retired`}
                </span>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer">
                  <Trans>Validation and source</Trans>
                </summary>
                <p className="my-2">
                  {version.validation.kind === "learning_constraints" ? (
                    <Trans>Historical constraints checked; profit improvement is unproven</Trans>
                  ) : (
                    <Trans>Deterministic constraints checked</Trans>
                  )}
                </p>
                <pre className="my-2 whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(version.validation, null, 2)}
                </pre>
                <code className="break-all">{version.artifactHash}</code>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {version.artifact}
                </pre>
              </details>
              {algorithmApprover && version.status !== "retired" ? (
                <div className="flex gap-2">
                  {version.status === "pending" ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void act(
                          () =>
                            api.trading.approveAlgorithm({
                              deskId: desk.id,
                              versionId: version.id,
                              expectedArtifactHash: version.artifactHash,
                            }),
                          true,
                        )
                      }
                    >
                      <Trans>Approve algorithm</Trans>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        () =>
                          api.trading.retireAlgorithm({ deskId: desk.id, versionId: version.id }),
                        true,
                      )
                    }
                  >
                    <Trans>Retire algorithm</Trans>
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {data?.intents.length ? (
        <section className="grid gap-3">
          <SectionHeading>
            <Trans>Trade intents</Trans>
          </SectionHeading>
          {data.intents.map((intent) => (
            <IntentCard
              key={intent.id}
              intent={intent}
              state={data}
              owner={owner}
              authorizer={tradeAuthorizer}
              botName={botName}
            />
          ))}
        </section>
      ) : null}
      <section className="grid gap-3 rounded-xl border p-4">
        <SectionHeading>
          <Trans>Bounded authorizations</Trans>
        </SectionHeading>
        {tradeAuthorizer && approved.length ? (
          <details>
            <summary className="cursor-pointer text-sm">
              <Trans>New authorization</Trans>
            </summary>
            <form
              onSubmit={grant}
              className="mt-3 grid gap-3 sm:grid-cols-2"
              aria-label={t`New authorization`}
            >
              <Field label={t`Algorithm version`}>
                <NativeSelect name="versionId">
                  {approved.map((version) => (
                    <NativeSelectOption key={version.id} value={version.id}>
                      {t`Margin`} {version.parameters.margin} · {version.id.slice(0, 8)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t`Executor`}>
                <NativeSelect name="botId">
                  <NativeSelectOption value="">{t`Scope owner`}</NativeSelectOption>
                  {data?.bindings
                    .filter(
                      (binding) => binding.role === "spot" || binding.role === "mid_long_term",
                    )
                    .map((binding) => (
                      <NativeSelectOption key={binding.botId} value={binding.botId}>
                        {botName(binding.botId)}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
              <Field label={t`Single intent limit (CNY)`}>
                <Input name="perTradeLimitCny" defaultValue="5000" inputMode="decimal" required />
              </Field>
              <Field label={t`Cumulative limit (CNY)`}>
                <Input
                  name="cumulativeLimitCny"
                  defaultValue="10000"
                  inputMode="decimal"
                  required
                />
              </Field>
              <Field label={t`Bot cancellation permission`}>
                <NativeSelect name="allowCancellation" defaultValue="false">
                  <NativeSelectOption value="false">{t`Human cancellation only`}</NativeSelectOption>
                  <NativeSelectOption value="true">{t`Allow executor bot to cancel`}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <p className="text-sm text-muted-foreground">
                <Trans>Valid for 24 hours</Trans>
              </p>
              <Button type="submit" disabled={pending}>
                <Trans>Create authorization</Trans>
              </Button>
            </form>
          </details>
        ) : null}
        {data?.grants.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
            <span>
              {row.botId ? botName(row.botId) : t`Scope owner`} · <Trans>Settled</Trans>{" "}
              {row.usedCny} / {row.cumulativeLimitCny} CNY · <Trans>Reserved</Trans>{" "}
              {row.reservedCny} CNY ·{" "}
              {row.revokedAt
                ? t`Revoked`
                : new Date(row.expiresAt) <= new Date()
                  ? t`Expired`
                  : t`Active`}
            </span>
            {tradeAuthorizer && !row.revokedAt ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void act(
                    () => api.trading.revokeGrant({ deskId: desk.id, grantId: row.id }),
                    true,
                  )
                }
              >
                <Trans>Revoke</Trans>
              </Button>
            ) : null}
          </div>
        ))}
        {!data?.grants.length ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No authorizations</Trans>
          </p>
        ) : null}
      </section>
      {data?.audit.length ? (
        <details
          className="rounded-xl border p-4"
          open={bot?.tradingRole === "review" || undefined}
        >
          <summary className="cursor-pointer text-sm">
            <Trans>Audit history</Trans>
          </summary>
          <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
            {data.audit.map((event) => (
              <li key={event.id}>
                {formatTradingInstant(event.createdAt, i18n.locale)} · {event.kind}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {identityDialog}
    </div>
  );
}

function DecisionSummary({ analysis }: { analysis: TradingAnalysis }) {
  return (
    <div className="grid gap-2 text-sm">
      <p>
        {analysis.decision.totalEnergyMwh} MWh · {analysis.decision.grossNotionalCny} CNY
      </p>
      <p className="text-muted-foreground">
        <Trans>Uncovered exposure</Trans>: {analysis.decision.uncoveredEnergyMwh} MWh
      </p>
      <Orders lines={analysis.decision.lines} timeZone={analysis.snapshot.rules.timezone} />
      <details>
        <summary className="cursor-pointer">
          <Trans>Input evidence</Trans>
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(analysis.snapshot, null, 2)}
        </pre>
      </details>
    </div>
  );
}
function Orders({
  lines,
  timeZone,
}: {
  lines: TradingStoredIntent["intent"]["lines"];
  timeZone: string;
}) {
  const { i18n } = useLingui();
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">
        <Trans>Orders</Trans> ({lines.length})
      </summary>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">
                <Trans>Delivery</Trans>
              </th>
              <th className="p-2">
                <Trans>Side</Trans>
              </th>
              <th className="p-2">MWh</th>
              <th className="p-2">CNY/MWh</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.start}-${index}`} className="border-t">
                <td className="whitespace-nowrap p-2">
                  {formatTradingInstant(line.start, i18n.locale, timeZone)}
                </td>
                <td className="p-2">
                  {line.side === "buy" ? <Trans>Buy</Trans> : <Trans>Sell</Trans>}
                </td>
                <td className="p-2">{line.energyMwh}</td>
                <td className="p-2">{line.limitPrice}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
function IntentCard({
  intent,
  state,
  owner,
  authorizer,
  botName,
}: {
  intent: TradingStoredIntent;
  state: State;
  owner: boolean;
  authorizer: boolean;
  botName: (id: string) => string;
}) {
  const { t, i18n } = useLingui();
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const names = useTradingNames();
  const cancelRequest = useRef(crypto.randomUUID());
  const [grantId, setGrantId] = useState("");
  const request = useRef<RpcInput<"trading/executeSimulation"> | null>(null);
  const [authorizationLocked, setAuthorizationLocked] = useState(false);
  const executed = state.executions.find((row) => row.intentId === intent.id);
  const version = state.versions.find((row) => row.id === intent.versionId);
  const expired = Date.parse(intent.intent.expiresAt) <= Date.now();
  const grants = state.grants.filter(
    (row) =>
      row.versionId === intent.versionId &&
      row.botId === null &&
      !row.revokedAt &&
      Date.parse(row.expiresAt) > Date.now(),
  );
  async function execute() {
    request.current ??= {
      deskId: intent.deskId,
      intentId: intent.id,
      expectedIntentHash: intent.intent.intentHash,
      clientRequestId: crypto.randomUUID(),
      ...(grantId ? { grantId } : {}),
    };
    const input = request.current;
    setAuthorizationLocked(true);
    const result = await act(() => api.trading.executeSimulation(input));
    const cause = result?.error;
    if (cause && typeof cause === "object" && "data" in cause) {
      const data = cause.data;
      if (
        data &&
        typeof data === "object" &&
        "reason" in data &&
        typeof data.reason === "string" &&
        !["IDEMPOTENCY_CONFLICT", "ALREADY_SUBMITTED"].includes(data.reason)
      ) {
        request.current = null;
        setAuthorizationLocked(false);
      }
    }
  }
  return (
    <article className="grid gap-3 rounded-xl border p-4" data-testid="trading-intent">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {intent.grossNotionalCny} CNY · {intent.botId ? botName(intent.botId) : t`Scope owner`}
        </p>
        <p className="text-sm text-muted-foreground">
          {executed
            ? names.status[executed.receipt.status]
            : expired
              ? t`Expired`
              : intent.approvedAt
                ? t`Trade approved`
                : t`Awaiting trade approval`}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        <Trans>Valid until</Trans>{" "}
        {formatTradingInstant(intent.intent.expiresAt, i18n.locale, intent.snapshot.rules.timezone)}
      </p>
      <Orders lines={intent.intent.lines} timeZone={intent.snapshot.rules.timezone} />
      <details className="text-sm">
        <summary className="cursor-pointer">
          <Trans>Approval evidence</Trans>
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(
            { intent: intent.intent, snapshot: intent.snapshot, parameters: intent.parameters },
            null,
            2,
          )}
        </pre>
      </details>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!executed && !expired ? (
        <div className="flex flex-wrap items-end gap-3">
          {authorizer && !intent.approvedAt ? (
            <Button
              disabled={pending}
              onClick={() =>
                void act(
                  () =>
                    api.trading.approveIntent({
                      deskId: intent.deskId,
                      intentId: intent.id,
                      expectedIntentHash: intent.intent.intentHash,
                    }),
                  true,
                )
              }
            >
              <Trans>Approve trade</Trans>
            </Button>
          ) : null}
          {owner && !intent.botId ? (
            <>
              <Field label={t`Authorization`}>
                <NativeSelect
                  value={grantId}
                  onChange={(event) => setGrantId(event.target.value)}
                  disabled={pending || authorizationLocked}
                >
                  <NativeSelectOption value="">{t`Per trade approval`}</NativeSelectOption>
                  {grants.map((row) => (
                    <NativeSelectOption key={row.id} value={row.id}>
                      ≤ {row.perTradeLimitCny} CNY · {row.usedCny} / {row.cumulativeLimitCny} CNY
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                disabled={
                  pending || version?.status !== "approved" || (!intent.approvedAt && !grantId)
                }
                onClick={() => void execute()}
              >
                <Trans>Execute simulation</Trans>
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {executed ? (
        <details open className="text-sm" data-testid="trading-receipt">
          <summary className="cursor-pointer">
            <Trans>Simulation receipt</Trans>
          </summary>
          <p className="mt-2">
            <Trans>Synthetic fill</Trans> · {names.status[executed.receipt.status]} ·{" "}
            {executed.receipt.fills.length} <Trans>fills</Trans>
          </p>
          <code className="break-all text-xs">{executed.clientRequestId}</code>
          {executed.receipt.status === "unknown" ? (
            <p className="mt-2 text-muted-foreground">
              <Trans>Result uncertain; the reservation is retained.</Trans>
            </p>
          ) : null}
          {!tradingExecutionTerminal(executed.receipt.status) ? (
            <div className="my-3 flex gap-2">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    api.trading.reconcileExecution({
                      deskId: intent.deskId,
                      executionId: executed.id,
                      expectedSequence: executed.receipt.sequence,
                    }),
                  )
                }
              >
                <Trans>Reconcile order</Trans>
              </Button>
              {authorizer ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () =>
                        api.trading.cancelSimulation({
                          deskId: intent.deskId,
                          executionId: executed.id,
                          clientRequestId: cancelRequest.current,
                        }),
                      true,
                    )
                  }
                >
                  <Trans>Cancel order</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          <details>
            <summary className="mt-2 cursor-pointer">
              <Trans>Receipt details</Trans>
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(executed.receipts, null, 2)}
            </pre>
          </details>
        </details>
      ) : null}
      {identityDialog}
    </article>
  );
}

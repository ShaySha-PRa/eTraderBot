import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  BusinessCycleState,
  BusinessEvidence,
  BusinessWorkKind,
  TradingAnalysis,
} from "@rakazo/contracts";
import { BusinessWorkResultSchema, isIdentityConfirmationRequired } from "@rakazo/contracts";
import {
  businessWorkRequirements,
  currentBusinessEvidence,
  latestBusinessEvidence,
} from "@rakazo/core";
import {
  Button,
  buttonVariants,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useTradingActions } from "../lib/trading-actions";
import { errorText } from "../lib/user-error";

type CycleTask = BusinessCycleState["tasks"][number];
/** A failed submission, shown inside its task form; `field` is null when no one input is at fault. */
/** What failed, kept instead of its words so the message follows the interface language. */
type TaskError = {
  field: keyof TaskDraft | null;
  stale?: boolean;
  /** Set for a field issue: its length limit, or null for any other issue. */
  limit?: number | null;
  reason?: string | null;
  cause?: unknown;
};
type DraftBasis = { resultEvidenceId: string | null; evidenceIds: string[] };
const resultFields: Record<string, keyof TaskDraft> = {
  summary: "summary",
  disagreements: "disagreements",
  unresolved: "unresolved",
  improvementProposal: "proposal",
};

/** The first result field a validation issue names, with its length limit when it was too long. */
function resultIssue(issues: unknown) {
  if (!Array.isArray(issues)) return null;
  for (const issue of issues as { path?: unknown[]; code?: unknown; maximum?: unknown }[]) {
    const path = (issue.path ?? []).map((part) =>
      part && typeof part === "object" && "key" in part ? part.key : part,
    );
    // Server issues are reported against the whole request: `result.<field>`.
    const field = resultFields[String(path[0] === "result" ? path[1] : path[0])];
    if (!field) continue;
    const limit =
      issue.code === "too_big" &&
      (typeof issue.maximum === "number" || typeof issue.maximum === "bigint")
        ? Number(issue.maximum)
        : null;
    return { field, limit };
  }
  return null;
}
type TaskDraft = { summary: string; disagreements: string; unresolved: string; proposal: string };
const emptyDraft: TaskDraft = { summary: "", disagreements: "", unresolved: "", proposal: "" };

/** Each cycle task keeps its own unsent result, so parallel forms never share text. */
function draftKey(cycleId: string, ticketId: string) {
  return `${cycleId}:${ticketId}`;
}

/** Clears only fields still holding what was sent, keeping anything typed during the request. */
function afterSent(drafts: Record<string, TaskDraft>, key: string, sent: TaskDraft) {
  const now = drafts[key];
  if (!now) return drafts;
  const left = Object.fromEntries(
    Object.entries(now).map(([field, value]) => [
      field,
      value === sent[field as keyof TaskDraft] ? "" : value,
    ]),
  ) as TaskDraft;
  const { [key]: _, ...rest } = drafts;
  return Object.values(left).some(Boolean) ? { ...rest, [key]: left } : rest;
}

/** Submission and clearing records belong to one market stage; other evidence does not. */
function stageOf(e: BusinessEvidence) {
  return (e.kind === "clearing" || e.kind === "submission") && typeof e.data.stage === "string"
    ? e.data.stage
    : null;
}

/** `roster` is the shell's live Bot list, refreshed on archive and polled, so assignee state stays current. */
export function BusinessCyclePage({ bot, roster }: { bot: Bot; roster: Bot[] }) {
  const fieldId = useId();
  const { t } = useLingui(),
    queries = useSpaceQueries(),
    cache = useQueryClient();
  const { api, act, pending, error, identityDialog } = useTradingActions();
  const list = useQuery(queries.businessCycle.list.queryOptions({ input: {} }));
  const [selected, setSelected] = useState("");
  const cycleId = selected || list.data?.[0]?.id || "";
  const state = useQuery({
    ...queries.businessCycle.get.queryOptions({ input: { cycleId } }),
    enabled: Boolean(cycleId),
    refetchInterval: 5000,
  });
  const desks = useQuery(queries.trading.desks.queryOptions({ input: {} }));
  const desk = desks.data?.find(
    (d) => d.scope.stage === (bot.tradingRole === "mid_long_term" ? "mid_long_term" : "day_ahead"),
  );
  const control = useQuery({
    ...queries.trading.desk.queryOptions({ input: { deskId: desk?.id ?? "" } }),
    enabled: Boolean(desk),
  });
  const [analysis, setAnalysis] = useState<TradingAnalysis | null>(null);
  const [kind, setKind] = useState<BusinessWorkKind>("contract_coverage"),
    [dependsOn, setDependsOn] = useState("");
  const [meterEnergy, setMeterEnergy] = useState("80"),
    [meterStatus, setMeterStatus] = useState<"estimated" | "confirmed">("confirmed");
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [draftBases, setDraftBases] = useState<Record<string, DraftBasis>>({});
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [taskErrors, setTaskErrors] = useState<Record<string, TaskError>>({});
  const data = state.data,
    current = currentBusinessEvidence(data?.evidence ?? []),
    latest = latestBusinessEvidence(data?.evidence ?? []);
  const intent = control.data?.intents.find(
    (r) => r.snapshot.source.sourceId === `business-cycle:${cycleId}`,
  );
  const execution = control.data?.executions.find((r) => r.intentId === intent?.id);
  const version = control.data?.versions.find((r) => r.id === intent?.versionId);
  const canTrade = bot.tradingRole === "spot" || bot.tradingRole === "mid_long_term";
  const spot = roster.find((b) => b.tradingRole === "spot");
  const names = {
    contracts: t`Contracts`,
    forecast: t`Forecast`,
    asset: t`Physical availability`,
    submission: t`Submission receipt`,
    clearing: t`Clearing`,
    delivery: t`Delivery evidence`,
    metering: t`Metering`,
    bill: t`Simulated bill`,
    settlement: t`Internal settlement trial`,
    review: t`Review result`,
  };
  const workNames: Record<BusinessWorkKind, string> = {
    contract_coverage: t`Contract coverage`,
    spot_analysis: t`Spot analysis`,
    risk_check: t`Risk check`,
    settlement_review: t`Settlement review`,
  };
  async function run(action: () => Promise<unknown>, human = false) {
    await act(action, human);
    await cache.invalidateQueries({ queryKey: queries.businessCycle.key() });
    await cache.invalidateQueries({ queryKey: queries.businessSupervisor.key() });
  }
  const fieldLabels: Record<keyof TaskDraft, string> = {
    summary: t`Human-recorded result`,
    disagreements: t`Disagreements`,
    unresolved: t`Unresolved`,
    proposal: t`Improvement proposal (not enabled)`,
  };
  function issueError(issues: unknown): TaskError | null {
    const issue = resultIssue(issues);
    if (!issue) return null;
    return { field: issue.field, limit: issue.limit };
  }
  function taskErrorText(error: TaskError) {
    if (error.field && error.limit !== undefined) {
      const label = fieldLabels[error.field],
        limit = error.limit;
      return limit === null
        ? `${label}: ${t`Could not continue`}`
        : t`${label} must be ${limit} characters or fewer`;
    }
    // An unknown refusal code gets generic copy rather than untranslated server text.
    if (error.reason) return refusals[error.reason] ?? t`Could not continue`;
    if (error.cause !== undefined) return errorText(error.cause, t`Could not continue`);
    return t`Could not continue`;
  }
  // Completion refusals carry a stable reason code; show copy in the interface language.
  const refusals: Record<string, string> = {
    MISSING_EVIDENCE: t`Required evidence or a prerequisite result is still missing`,
    STALE_DATA: t`Evidence changed. Check the latest versions and submit again`,
    FORBIDDEN: t`You can't record this result`,
    NOT_FOUND: t`This task is no longer available`,
  };
  function setTaskError(key: string, error: TaskError | null) {
    setTaskErrors(({ [key]: _, ...rest }) => (error ? { ...rest, [key]: error } : rest));
  }
  function basisFor(task: CycleTask): DraftBasis {
    return {
      resultEvidenceId: task.resultEvidenceId ?? null,
      evidenceIds: current
        .filter((e) => businessWorkRequirements[task.kind].evidence.includes(e.streamKey))
        .map((e) => e.id),
    };
  }
  function editDraft(key: string, field: keyof TaskDraft, value: string, task: CycleTask) {
    const hasDraft = Object.values(drafts[key] ?? emptyDraft).some(Boolean);
    setDraftBases((all) => (hasDraft && key in all ? all : { ...all, [key]: basisFor(task) }));
    setDrafts((all) => ({ ...all, [key]: { ...(all[key] ?? emptyDraft), [field]: value } }));
    // Editing the field at fault, or any field for a general failure, retires the message.
    setTaskErrors((all) => {
      const shown = all[key];
      if (!shown || shown.stale || (shown.field && shown.field !== field)) return all;
      const { [key]: _, ...rest } = all;
      return rest;
    });
  }
  function completeTask(task: CycleTask) {
    // Send the draft's original evidence basis; later edits or refetches cannot move this request.
    const key = draftKey(cycleId, task.ticketId);
    const sent = drafts[key] ?? emptyDraft;
    const basis = draftBases[key] ?? basisFor(task);
    const evidenceIds = basis.evidenceIds;
    const result = {
      summary: sent.summary,
      evidenceIds,
      disagreements: sent.disagreements ? [sent.disagreements] : [],
      unresolved: sent.unresolved ? [sent.unresolved] : [],
      improvementProposal: sent.proposal || null,
    };
    // The shared contract names the field and limit before a round trip; the server still decides.
    const checked = BusinessWorkResultSchema.safeParse(result);
    if (!checked.success) {
      setTaskError(key, issueError(checked.error.issues) ?? { field: null });
      return Promise.resolve();
    }
    setTaskError(key, null);
    return run(async () => {
      try {
        await api.businessCycle.complete({
          ticketId: task.ticketId,
          result,
          expectedResultEvidenceId: basis.resultEvidenceId,
        });
      } catch (cause) {
        if (isIdentityConfirmationRequired(cause)) throw cause;
        // Report the failure in this task's form only; the draft stays as typed.
        const data = cause && typeof cause === "object" && "data" in cause ? cause.data : undefined;
        const detail = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        const reason = typeof detail.reason === "string" ? detail.reason : null;
        setTaskError(
          key,
          issueError(detail.issues) ?? {
            field: null,
            stale: reason === "STALE_DATA",
            ...(reason ? { reason } : { cause }),
          },
        );
        return;
      }
      setDrafts((all) => afterSent(all, key, sent));
    });
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="business-cycle">
      {identityDialog}
      <div className="mx-auto max-w-5xl space-y-5">
        <SectionHeading>
          <Trans>Business cycle</Trans>
        </SectionHeading>
        <p className="text-sm text-muted-foreground">
          <Trans>
            P25 teaching simulation · Energy settlement is not net profit. This is not a regional
            market rule.
          </Trans>
        </p>
        {error || state.error || list.error ? (
          <p role="alert" className="text-destructive">
            {error || errorText(state.error || list.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label={t`Business cycle`}
            value={cycleId}
            onChange={(e) => {
              setSelected(e.target.value);
              setAnalysis(null);
            }}
          >
            <NativeSelectOption value="">—</NativeSelectOption>
            {list.data?.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const created = await api.businessCycle.createDemo({
                  requestId: crypto.randomUUID(),
                });
                setSelected(created.cycle.id);
              }, true)
            }
          >
            <Trans>Load P25 simulation</Trans>
          </Button>
          {!canTrade && spot ? (
            <a
              className={buttonVariants({ variant: "outline" })}
              href={`/app/${spot.id}?workspace=cycle`}
            >
              <Trans>Open spot Bot</Trans>
            </a>
          ) : null}
        </div>
        {data ? (
          <>
            <details className="rounded border p-3">
              <summary>
                <Trans>Market rules and windows</Trans> · {data.cycle.rule.version}
              </summary>
              <ul className="mt-2 space-y-1 text-sm">
                {data.cycle.rule.stages.map((r) => (
                  <li key={r.stage}>
                    {r.stage} ·{" "}
                    {r.mode === "quantity_price"
                      ? t`Quantity and price submission`
                      : t`Results only / closed`}{" "}
                    · {new Date(r.opensAt).toLocaleString()} —{" "}
                    {new Date(r.closesAt).toLocaleString()} ·{" "}
                    {r.allowRevision ? t`Revision allowed` : t`Sealed after submission`}
                  </li>
                ))}
              </ul>
            </details>
            <section className="space-y-2">
              <SectionHeading>
                <Trans>Shared evidence</Trans>
              </SectionHeading>
              {latest.map((e) => (
                <details
                  key={e.id}
                  className="rounded border p-3 text-sm"
                  data-testid={`evidence-${e.streamKey}`}
                >
                  <summary className="cursor-pointer break-words">
                    {names[e.kind]}
                    {stageOf(e) ? ` · ${stageOf(e)}` : ""} · v{e.revision} ·{" "}
                    {e.status === "confirmed" ? t`Confirmed` : t`Estimated`}
                    {e.supersedesId ? ` · ${t`Correction`}` : ""}
                    {!current.some((r) => r.id === e.id) ? ` · ${t`Needs recalculation`}` : ""}
                  </summary>
                  <p className="mt-2 break-all text-muted-foreground">
                    {e.origin === "synthetic" ? t`Synthetic source` : t`Internal trial`} ·{" "}
                    {e.source} · {e.sourceRecordId}
                  </p>
                  <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                  <p className="break-all">
                    {t`Evidence ID`}: {e.id}
                  </p>
                  <p className="break-all">
                    {t`References`}: {e.references.join(", ") || "—"}
                  </p>
                </details>
              ))}
            </section>
            {canTrade && desk ? (
              <section className="space-y-3 rounded border p-3">
                <SectionHeading>
                  <Trans>Analysis and simulated submission</Trans>
                </SectionHeading>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void run(async () =>
                        setAnalysis(
                          await api.businessCycle.analyze({
                            cycleId,
                            deskId: desk.id,
                            margin: "0",
                          }),
                        ),
                      )
                    }
                  >
                    <Trans>Analyze shared evidence</Trans>
                  </Button>
                  {analysis && analysis.snapshot.source.sourceId === `business-cycle:${cycleId}` ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void run(() =>
                          api.trading.prepareIntent({
                            deskId: desk.id,
                            analysisId: analysis.id,
                            expiresAt: new Date(Date.now() + 900000).toISOString(),
                          }),
                        )
                      }
                    >
                      <Trans>Prepare intent</Trans>
                    </Button>
                  ) : null}
                  {intent && version?.status !== "approved" ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () =>
                            api.trading.approveAlgorithm({
                              deskId: desk.id,
                              versionId: intent.versionId,
                              expectedArtifactHash: version!.artifactHash,
                            }),
                          true,
                        )
                      }
                    >
                      <Trans>Approve algorithm</Trans>
                    </Button>
                  ) : null}
                  {intent && !intent.approvedAt ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () =>
                            api.trading.approveIntent({
                              deskId: desk.id,
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
                  {intent && !execution ? (
                    <Button
                      disabled={pending || !intent.approvedAt || version?.status !== "approved"}
                      onClick={() =>
                        void run(() =>
                          api.trading.executeSimulation({
                            deskId: desk.id,
                            intentId: intent.id,
                            expectedIntentHash: intent.intent.intentHash,
                            clientRequestId: `cycle-${intent.id}`,
                          }),
                        )
                      }
                    >
                      <Trans>Submit simulation</Trans>
                    </Button>
                  ) : null}
                </div>
                {analysis ? (
                  <p className="text-sm">
                    {t`Candidate energy`}: {analysis.decision.totalEnergyMwh} MWh ·{" "}
                    {t`Algorithm version`}:{" "}
                    <span className="break-all">{analysis.decision.algorithmVersionId}</span>
                  </p>
                ) : null}
                {execution ? (
                  <p className="text-sm">
                    {t`Submission receipt`}: {execution.receipt.status} ·{" "}
                    <span className="break-all">{execution.id}</span>
                  </p>
                ) : null}
              </section>
            ) : null}
            <section className="space-y-3 rounded border p-3">
              <SectionHeading>
                <Trans>Results, metering and reconciliation</Trans>
              </SectionHeading>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    pending ||
                    !execution ||
                    current.some((e) => e.streamKey === "clearing:day_ahead")
                  }
                  onClick={() =>
                    void run(
                      () => api.businessCycle.demoResults({ cycleId, executionId: execution!.id }),
                      true,
                    )
                  }
                >
                  <Trans>Import simulated results</Trans>
                </Button>
                <label htmlFor={`${fieldId}-energy`} className="grid gap-1 text-sm">
                  {t`Actual energy (MWh)`}
                  <Input
                    id={`${fieldId}-energy`}
                    value={meterEnergy}
                    onChange={(e) => setMeterEnergy(e.target.value)}
                  />
                </label>
                <NativeSelect
                  aria-label={t`Metering status`}
                  value={meterStatus}
                  onChange={(e) => setMeterStatus(e.target.value as "estimated" | "confirmed")}
                >
                  <NativeSelectOption value="estimated">{t`Estimated`}</NativeSelectOption>
                  <NativeSelectOption value="confirmed">{t`Confirmed`}</NativeSelectOption>
                </NativeSelect>
                <Button
                  disabled={pending || !current.some((e) => e.kind === "delivery")}
                  onClick={() =>
                    void run(
                      () =>
                        api.businessCycle.demoMetering({
                          cycleId,
                          energyMwh: meterEnergy,
                          status: meterStatus,
                          supersedesId: latest.find((e) => e.kind === "metering")?.id,
                          requestId: crypto.randomUUID(),
                        }),
                      true,
                    )
                  }
                >
                  {latest.some((e) => e.kind === "metering")
                    ? t`Append metering correction`
                    : t`Import simulated metering`}
                </Button>
                <Button
                  disabled={pending || !current.some((e) => e.kind === "metering")}
                  onClick={() => void run(() => api.businessCycle.settle({ cycleId }))}
                >
                  <Trans>Reconcile settlement</Trans>
                </Button>
              </div>
              {data.settlement ? (
                <div className="space-y-2" data-testid="settlement-result">
                  <p>
                    <Trans>Energy settlement</Trans>:{" "}
                    <strong>{data.settlement.energyAmountCny} CNY</strong> ·{" "}
                    <Trans>Equivalent difference form</Trans>:{" "}
                    {data.settlement.equivalentDifferenceCny} CNY
                  </p>
                  <div className="overflow-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th>{t`Contract`}</th>
                          <th>{t`Day-ahead deviation`}</th>
                          <th>{t`Real-time deviation`}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.settlement.lines.map((l) => (
                          <tr key={l.start}>
                            <td>
                              {l.contractMwh} MWh · {l.contractCny} CNY
                            </td>
                            <td>
                              {l.dayAheadDeviationMwh} MWh · {l.dayAheadDeviationCny} CNY
                            </td>
                            <td>
                              {l.realtimeDeviationMwh} MWh · {l.realtimeDeviationCny} CNY
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-sm">
                    {t`Bill difference`}: {data.settlement.billDifferenceCny ?? t`Missing`} CNY ·{" "}
                    {t`Costs`}: {data.settlement.costsCny ?? t`Missing`} · {t`Other fees`}:{" "}
                    {data.settlement.otherFeesCny ?? t`Missing`} · {t`Net profit`}:{" "}
                    {t`Not established`}
                  </p>
                </div>
              ) : null}
              <p className="text-sm">
                {data.reviewReady
                  ? t`Settlement evidence ready for review`
                  : `${t`Waiting for evidence`}: ${data.blockers.join(", ")}`}
              </p>
            </section>
            <section className="space-y-3">
              <SectionHeading>
                <Trans>Role tasks and dependencies</Trans>
              </SectionHeading>
              <div className="flex flex-wrap gap-2">
                <NativeSelect
                  aria-label={t`Requested work`}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as BusinessWorkKind)}
                >
                  {Object.entries(workNames).map(([k, n]) => (
                    <NativeSelectOption key={k} value={k}>
                      {n}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label={t`Depends on task`}
                  value={dependsOn}
                  onChange={(e) => setDependsOn(e.target.value)}
                >
                  <NativeSelectOption value="">{t`Independent task`}</NativeSelectOption>
                  {data.tasks.map((task) => (
                    <NativeSelectOption key={task.ticketId} value={task.ticketId}>
                      {task.ref} · {workNames[task.kind]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      api.businessCycle.assign({
                        cycleId,
                        kind,
                        requestId: crypto.randomUUID(),
                        dependsOn: dependsOn ? [dependsOn] : [],
                      }),
                    )
                  }
                >
                  <Trans>Assign necessary role</Trans>
                </Button>
              </div>
              {data.tasks.map((task) => {
                const key = draftKey(cycleId, task.ticketId),
                  draft = drafts[key] ?? emptyDraft,
                  taskError = taskErrors[key],
                  describedBy = (field: keyof TaskDraft) =>
                    taskError && (taskError.field === null || taskError.field === field)
                      ? `${id}-error`
                      : undefined,
                  id = `${fieldId}-${task.ticketId}`,
                  // Start gaps decide whether work can begin; `blockers` still gate completion.
                  start = task.startBlockers ?? task.blockers,
                  assignee = roster.find((b) => b.id === task.assigneeBotId),
                  // Active lists omit archived Bots, so a set but unlisted assignee is archived.
                  ownerMissing = !task.assigneeBotId || !assignee,
                  candidates = ownerMissing
                    ? roster.filter(
                        (b) =>
                          b.tradingRole === businessWorkRequirements[task.kind].role &&
                          !b.businessSupervisor &&
                          !b.archivedAt,
                      )
                    : [],
                  owner = owners[task.ticketId] ?? candidates[0]?.id ?? "";
                return (
                  <details
                    key={key}
                    className="rounded border p-3 text-sm"
                    data-testid={`cycle-task-${task.ticketId}`}
                  >
                    <summary>
                      {task.ref} · {workNames[task.kind]} · {task.status} ·{" "}
                      {!task.assigneeBotId ? t`Unassigned` : (assignee?.name ?? t`Archived`)}
                    </summary>
                    <p className="mt-2 break-all">
                      {start.length
                        ? `${t`Blocked`}: ${start.join(", ")}`
                        : task.blockers.length && task.status !== "done"
                          ? `${t`Ready to investigate`} · ${t`Needed to complete`}: ${task.blockers.join(", ")}`
                          : t`Required evidence available`}
                    </p>
                    {candidates.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <NativeSelect
                          aria-label={t`Assignee`}
                          value={owner}
                          onChange={(e) =>
                            setOwners((all) => ({ ...all, [task.ticketId]: e.target.value }))
                          }
                        >
                          {candidates.map((b) => (
                            <NativeSelectOption key={b.id} value={b.id}>
                              {b.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        <Button
                          variant="outline"
                          disabled={pending || !owner}
                          onClick={() =>
                            void run(
                              () => api.tickets.update({ id: task.ticketId, assigneeBotId: owner }),
                              true,
                            )
                          }
                        >
                          <Trans>Restore</Trans>
                        </Button>
                      </div>
                    ) : null}
                    {task.result ? (
                      <div className="mt-2 space-y-1">
                        <p>{task.result.summary}</p>
                        <p>
                          {t`Disagreements`}: {task.result.disagreements.join("; ") || "—"}
                        </p>
                        <p>
                          {t`Unresolved`}: {task.result.unresolved.join("; ") || "—"}
                        </p>
                        <p>
                          {t`Improvement proposal (not enabled)`}:{" "}
                          {task.result.improvementProposal ?? "—"}
                        </p>
                        <p className="break-all">
                          {t`References`}: {task.result.evidenceIds.join(", ")}
                        </p>
                      </div>
                    ) : null}
                    {!start.length && task.status !== "done" ? (
                      <div className="mt-3 grid gap-2">
                        <label htmlFor={`${id}-summary`}>
                          {t`Human-recorded result`}
                          <Textarea
                            id={`${id}-summary`}
                            aria-invalid={taskError?.field === "summary" || undefined}
                            aria-describedby={describedBy("summary")}
                            value={draft.summary}
                            onChange={(e) => editDraft(key, "summary", e.target.value, task)}
                          />
                        </label>
                        <label htmlFor={`${id}-disagreements`}>
                          {t`Disagreements`}
                          <Input
                            id={`${id}-disagreements`}
                            aria-invalid={taskError?.field === "disagreements" || undefined}
                            aria-describedby={describedBy("disagreements")}
                            value={draft.disagreements}
                            onChange={(e) => editDraft(key, "disagreements", e.target.value, task)}
                          />
                        </label>
                        <label htmlFor={`${id}-unresolved`}>
                          {t`Unresolved`}
                          <Input
                            id={`${id}-unresolved`}
                            aria-invalid={taskError?.field === "unresolved" || undefined}
                            aria-describedby={describedBy("unresolved")}
                            value={draft.unresolved}
                            onChange={(e) => editDraft(key, "unresolved", e.target.value, task)}
                          />
                        </label>
                        <label htmlFor={`${id}-proposal`}>
                          {t`Improvement proposal (not enabled)`}
                          <Textarea
                            id={`${id}-proposal`}
                            aria-invalid={taskError?.field === "proposal" || undefined}
                            aria-describedby={describedBy("proposal")}
                            value={draft.proposal}
                            onChange={(e) => editDraft(key, "proposal", e.target.value, task)}
                          />
                        </label>
                        {taskError ? (
                          <p role="alert" id={`${id}-error`} className="text-sm text-destructive">
                            {taskErrorText(taskError)}
                          </p>
                        ) : null}
                        {taskError?.stale ? (
                          <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              setDraftBases((all) => ({ ...all, [key]: basisFor(task) }));
                              setTaskError(key, null);
                            }}
                          >
                            <Trans>Use latest version</Trans>
                          </Button>
                        ) : null}
                        <Button
                          disabled={pending || !draft.summary.trim()}
                          onClick={() => void completeTask(task)}
                        >
                          <Trans>Record sourced result</Trans>
                        </Button>
                      </div>
                    ) : null}
                  </details>
                );
              })}
            </section>
            <details className="rounded border p-3 text-sm">
              <summary>
                <Trans>Evidence history</Trans> · {data.evidence.length}
              </summary>
              {data.evidence.map((e) => (
                <p key={e.id} className="mt-2 break-all">
                  {e.streamKey}
                  {e.kind === "submission" && stageOf(e) ? ` · ${stageOf(e)}` : ""} · v{e.revision}{" "}
                  · {e.id} · {e.receivedAt} ·{" "}
                  {e.supersedesId ? `${t`Supersedes`}: ${e.supersedesId}` : e.sourceRecordId}
                </p>
              ))}
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}

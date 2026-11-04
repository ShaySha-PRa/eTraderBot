import { Trans, useLingui } from "@lingui/react/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { formatTradingInstant, newClientId } from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useId, useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import type { rpcForSpace } from "../lib/rpc";

type Plan = RpcOutput<"trading/learningState">["plans"][number];
type Props = {
  deskId: string;
  botId?: string;
  owner: boolean;
  bots: Array<{ id: string; name: string }>;
  api: ReturnType<typeof rpcForSpace>;
  act: (action: () => Promise<unknown>, human?: boolean) => Promise<unknown>;
  pending: boolean;
};
export function TradingLearning({ deskId, botId, owner, bots, api, act, pending }: Props) {
  const { t, i18n } = useLingui();
  const sourceKinds = {
    chat: t`Chat feedback`,
    file: t`File`,
    operation: t`Authorized operation`,
    history: t`Historical data`,
  };
  const runStatuses: Record<string, string> = {
    queued: t`Queued`,
    leased: t`Starting`,
    running: t`Running`,
    waiting_input: t`Waiting for input`,
    waiting_takeover: t`Waiting for you`,
    completed: t`Completed`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
  };
  const queries = useSpaceQueries();
  const desks = useQuery(queries.trading.desks.queryOptions({ input: {} }));
  const state = useQuery({
    ...queries.trading.learningState.queryOptions({ input: { deskId } }),
    refetchInterval: 5000,
  });
  const [sourceText, setSourceText] = useState("");
  const [reference, setReference] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceId = useId(),
    refId = useId(),
    fileId = useId();
  const name = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  async function add(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      await api.trading.addLearningSource({ deskId, kind: "chat", reference, content: sourceText });
      setSourceText("");
      setReference("");
    });
  }
  return (
    <section className="grid min-w-0 gap-4 rounded-xl border p-4" aria-label={t`Learning`}>
      <SectionHeading>
        <Trans>Learning</Trans>
      </SectionHeading>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Daily and manual learning use the bot's model connection. New candidates require human
          approval.
        </Trans>
      </p>
      {state.isError ? (
        <p role="alert">
          <Trans>Could not load learning records</Trans>
        </p>
      ) : null}
      {!state.data?.plans.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Bind a trading bot to create a learning plan.</Trans>
        </p>
      ) : null}
      {state.data?.plans
        .filter((plan) => !botId || plan.botId === botId)
        .map((plan) => (
          <LearningPlan
            key={`${plan.id}:${plan.schedule.time}:${plan.schedule.timezone}:${plan.schedule.active}:${plan.baselineMargin}`}
            plan={plan}
            botName={name(plan.botId)}
            {...{ api, act, pending, owner }}
          />
        ))}
      {owner ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Add learning material</Trans>
          </summary>
          <p className="my-2 text-sm text-muted-foreground">
            <Trans>
              Materials apply only to this scope. Attach chat feedback explicitly; upload text,
              Markdown, CSV or JSON files up to 64 KB.
            </Trans>
          </p>
          <form onSubmit={add} className="grid gap-2">
            <label htmlFor={refId} className="text-sm">
              <Trans>Source reference</Trans>
            </label>
            <Input
              id={refId}
              value={reference}
              maxLength={500}
              required
              onChange={(e) => setReference(e.target.value)}
            />
            <label htmlFor={sourceId} className="text-sm">
              <Trans>Trader feedback</Trans>
            </label>
            <Textarea
              id={sourceId}
              value={sourceText}
              maxLength={64000}
              required
              onChange={(e) => setSourceText(e.target.value)}
            />
            <Button
              type="submit"
              disabled={pending || !sourceText.trim() || !reference.trim()}
              className="justify-self-start"
            >
              <Trans>Save material</Trans>
            </Button>
          </form>
          <label htmlFor={fileId} className="mt-3 block text-sm">
            <Trans>Upload learning file</Trans>
          </label>
          <Input
            ref={fileInput}
            id={fileId}
            type="file"
            className="hidden"
            accept=".txt,.md,.csv,.json,text/*,application/json"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void act(async () => {
                  if (file.size > 64000) throw new Error(t`Choose a text file up to 64 KB`);
                  const content = new TextDecoder("utf-8", { fatal: true }).decode(
                    await file.arrayBuffer(),
                  );
                  if (content.includes("\u0000")) throw new Error(t`Choose a UTF-8 text file`);
                  await api.trading.addLearningSource({
                    deskId,
                    kind: "file",
                    reference: file.name,
                    content,
                  });
                });
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="mt-1"
            disabled={pending}
            onClick={() => fileInput.current?.click()}
          >
            <Trans>Upload file</Trans>
          </Button>
        </details>
      ) : null}
      {state.data?.sources.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Authorized materials</Trans> ({state.data.sources.length})
          </summary>
          <ul className="mt-2 grid gap-2 text-sm">
            {state.data.sources.map((source) => (
              <li key={source.id}>
                <details>
                  <summary className="cursor-pointer break-all">
                    {sourceKinds[source.kind]} · {source.reference}
                  </summary>
                  <p className="break-all text-xs text-muted-foreground">{source.contentHash}</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {source.content}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {state.data?.sessions.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Learning runs</Trans>
          </summary>
          <ul className="mt-2 grid gap-2 text-sm">
            {state.data.sessions
              .filter((session) => !botId || session.botId === botId)
              .map((session) => (
                <li key={session.runId} className="break-words">
                  {name(session.botId)} · {formatTradingInstant(session.createdAt, i18n.locale)} ·{" "}
                  {runStatuses[session.runStatus] ?? session.runStatus}
                  {session.error ? (
                    <p role="alert" className="text-destructive">
                      {session.error}
                    </p>
                  ) : null}
                  {!session.reportId && session.runStatus === "completed" ? (
                    <p className="text-muted-foreground">
                      <Trans>
                        Run finished without a learning report. Review the conversation and retry.
                      </Trans>
                    </p>
                  ) : null}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {state.data?.reports
        .filter(
          (report) =>
            !botId ||
            state.data.sessions.some(
              (session) => session.botId === botId && session.reportId === report.id,
            ),
        )
        .map((report) => (
          <article
            key={report.id}
            className="grid min-w-0 gap-2 rounded-lg border p-3"
            data-testid="learning-report"
          >
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span>{formatTradingInstant(report.createdAt, i18n.locale)}</span>
              <span>
                {report.outcome === "no_new_data"
                  ? t`No new material`
                  : report.outcome === "no_data"
                    ? t`No authorized material`
                    : report.validation === "constraints_passed"
                      ? t`Constraints passed · human review required`
                      : report.validation === "constraints_failed"
                        ? t`Constraints failed`
                        : t`Insufficient historical data`}
              </span>
            </div>
            {report.experience ? (
              <p className="whitespace-pre-wrap break-words text-sm">{report.experience}</p>
            ) : null}
            {report.hypothesis ? (
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {report.hypothesis}
              </p>
            ) : null}
            {report.outcome === "proposal" ? (
              <p className="text-sm">
                <Trans>Baseline margin</Trans>: {report.baselineMargin} ·{" "}
                <Trans>Candidate margin</Trans>: {report.candidateMargin}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              <Trans>Profit improvement and semantic quality have not been established.</Trans>
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer">
                <Trans>Validation evidence</Trans>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(
                  {
                    inputHash: report.inputHash,
                    validatorVersion: report.validatorVersion,
                    engineHash: report.engineHash,
                    sourceIds: report.sourceIds,
                    citedSourceIds: report.citedSourceIds,
                    comparisons: report.comparisons,
                    versionId: report.versionId,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {owner && report.experience && desks.data?.some((desk) => desk.id !== deskId) ? (
              <details className="text-sm">
                <summary className="cursor-pointer">
                  <Trans>Share experience</Trans>
                </summary>
                <form
                  className="mt-2 flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const targetDeskId = String(
                      new FormData(event.currentTarget).get("targetDeskId"),
                    );
                    void act(
                      () =>
                        api.trading.shareLearningExperience({
                          deskId,
                          reportId: report.id,
                          targetDeskId,
                        }),
                      true,
                    );
                  }}
                >
                  <NativeSelect
                    name="targetDeskId"
                    aria-label={t`Target scope`}
                    className="max-w-full"
                  >
                    {desks.data
                      ?.filter((desk) => desk.id !== deskId)
                      .map((desk) => (
                        <NativeSelectOption key={desk.id} value={desk.id}>
                          {desk.scope.subjectId} · {desk.scope.accountId}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                  <Button type="submit" variant="outline" size="sm" disabled={pending}>
                    <Trans>Share selected experience</Trans>
                  </Button>
                </form>
                <p className="mt-2 text-muted-foreground">
                  <Trans>
                    Only this experience text is shared. Raw materials and source reports stay in
                    their original scope.
                  </Trans>
                </p>
              </details>
            ) : null}
          </article>
        ))}
    </section>
  );
}

function LearningPlan({
  plan,
  botName,
  owner,
  api,
  act,
  pending,
}: { plan: Plan; botName: string } & Pick<Props, "owner" | "api" | "act" | "pending">) {
  const { t, i18n } = useLingui();
  const [time, setTime] = useState(plan.schedule.time),
    [timezone, setTimezone] = useState(plan.schedule.timezone);
  const [active, setActive] = useState(plan.schedule.active),
    [baselineMargin, setBaseline] = useState(plan.baselineMargin);
  const timeId = useId(),
    zoneId = useId(),
    activeId = useId(),
    baselineId = useId();
  const request = useRef("");
  async function save(event: FormEvent) {
    event.preventDefault();
    await act(() =>
      api.trading.configureLearning({
        deskId: plan.deskId,
        botId: plan.botId,
        schedule: { time, timezone, active },
        baselineMargin,
      }),
    );
  }
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{botName}</span>
        {owner ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                request.current ||= newClientId();
                await api.trading.startLearning({
                  deskId: plan.deskId,
                  botId: plan.botId,
                  clientRequestId: request.current,
                });
                request.current = "";
              })
            }
          >
            <Trans>Learn now</Trans>
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {plan.schedule.time} · {plan.schedule.timezone} ·{" "}
        {plan.schedule.active ? t`Daily` : t`Paused`}
      </p>
      {plan.nextRunAt ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Next learning run</Trans>:{" "}
          {formatTradingInstant(plan.nextRunAt, i18n.locale, plan.schedule.timezone)}
        </p>
      ) : null}
      {owner ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Edit learning plan</Trans>
          </summary>
          <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-3">
            <div className="grid gap-1 text-sm">
              <label htmlFor={timeId}>
                <Trans>Daily time</Trans>
              </label>
              <Input
                id={timeId}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor={zoneId}>
                <Trans>Time zone</Trans>
              </label>
              <Input
                id={zoneId}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor={baselineId}>
                <Trans>Baseline margin</Trans>
              </label>
              <Input
                id={baselineId}
                value={baselineMargin}
                onChange={(e) => setBaseline(e.target.value)}
                required
                inputMode="decimal"
                className="w-28"
              />
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor={activeId}>
                <Trans>Learning schedule</Trans>
              </label>
              <NativeSelect
                id={activeId}
                value={String(active)}
                onChange={(e) => setActive(e.target.value === "true")}
              >
                <NativeSelectOption value="true">{t`Daily`}</NativeSelectOption>
                <NativeSelectOption value="false">{t`Paused`}</NativeSelectOption>
              </NativeSelect>
            </div>
            <Button type="submit" disabled={pending}>
              <Trans>Save plan</Trans>
            </Button>
          </form>
        </details>
      ) : null}
    </div>
  );
}

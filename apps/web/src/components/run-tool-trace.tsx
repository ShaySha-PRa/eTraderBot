import { t as tr } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RunStatus,
  RunToolStatus,
  RunTraceDetail,
  SafeReadonlySourceSummary,
} from "@rakazo/contracts";
import { isRetryableError, isServerUnreachable } from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";
import { errorCode } from "../lib/user-error";

/** Business times are read in China Standard Time whatever the browser's zone. */
export const TIME_ZONE = "Asia/Shanghai";
export const ACTIVE: ReadonlySet<RunStatus> = new Set([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
]);
const POLL_MS = 5_000;

/**
 * A short code for a run or attempt: the random tail of its ID, so ones started in the same
 * second still read differently, and the code never changes with paging or list position.
 */
export function shortCode(id: string): string {
  return id.slice(-8);
}

export const poll = (active: boolean, error: unknown) =>
  error && !isRetryableError(error) ? false : active ? POLL_MS : false;

type ToolCall = RunTraceDetail["toolTrace"]["calls"][number];

/** Calls grouped by the attempt that made them, attempts in order of their first recorded call. */
function byAttempt(calls: ToolCall[]): { attemptId: string; calls: ToolCall[] }[] {
  const groups = new Map<string, ToolCall[]>();
  for (const call of calls)
    groups.set(call.attemptId, [...(groups.get(call.attemptId) ?? []), call]);
  return [...groups].map(([attemptId, calls]) => ({ attemptId, calls }));
}

export function ToolTrace({ trace }: { trace: RunTraceDetail["toolTrace"] }) {
  const { t } = useLingui();
  const attempts = byAttempt(trace.calls);
  // A run resumed in a new attempt keeps the earlier attempt's calls, including late refusals;
  // grouping shows which attempt each status belongs to instead of one list that reads as final.
  const grouped = attempts.length > 1;
  return (
    <div className="space-y-1">
      <h4 className="font-medium">
        <Trans>Tools</Trans>
      </h4>
      {!trace.recorded ? (
        <p className="text-muted-foreground">
          <Trans>Tool summary not recorded</Trans>
        </p>
      ) : trace.calls.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No tool calls recorded</Trans>
        </p>
      ) : null}
      {grouped ? (
        attempts.map((attempt) => {
          const code = shortCode(attempt.attemptId);
          return (
            <section
              key={attempt.attemptId}
              data-testid="tool-attempt"
              aria-label={t`Attempt ${code}`}
              className="space-y-1 pt-1"
            >
              <h5 className="text-xs text-muted-foreground">
                {t`Attempt`} <span className="font-mono">#{code}</span>
              </h5>
              <ToolCalls calls={attempt.calls} timed />
            </section>
          );
        })
      ) : trace.calls.length > 0 ? (
        <ToolCalls calls={trace.calls} />
      ) : null}
      {trace.truncated ? (
        <p className="text-muted-foreground">
          <Trans>Showing only the first tool calls</Trans>
        </p>
      ) : null}
    </div>
  );
}

/** With several attempts, each call's start time shows when a late result arrived. */
function ToolCalls({ calls, timed = false }: { calls: ToolCall[]; timed?: boolean }) {
  const { i18n } = useLingui();
  return (
    <ul className="space-y-1">
      {calls.map((call) => (
        <li key={call.id} className="min-w-0">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate font-mono text-xs" title={call.name}>
              {call.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {timed ? (
                <>
                  <time dateTime={call.startedAt}>{formatClock(call.startedAt, i18n.locale)}</time>
                  {" · "}
                </>
              ) : null}
              <span className={toolTone(call.status)}>{toolStatusText(call.status)}</span>
              {call.durationMs === null
                ? null
                : ` · ${formatDuration(call.durationMs, i18n.locale)}`}
            </span>
          </div>
          {call.resultSummary ? <ResultSummary summary={call.resultSummary} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useLingui();
  const code = errorCode(error);
  const text =
    code === "NOT_FOUND"
      ? t`This run is no longer available`
      : code === "FORBIDDEN"
        ? t`You no longer have access`
        : isServerUnreachable(error)
          ? t`Could not reach the server`
          : t`Could not load runs`;
  return (
    <div className="flex items-center gap-2">
      <p role="alert" className="text-destructive">
        {text}
      </p>
      {code === "NOT_FOUND" || code === "FORBIDDEN" ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
  );
}

function toolStatusText(status: RunToolStatus): string {
  switch (status) {
    case "pending":
      return tr`In progress`;
    case "waiting":
      return tr`Waiting for approval`;
    case "completed":
      return tr`Done`;
    case "failed":
      return tr`Failed`;
    case "refused":
      return tr`Refused`;
    case "ambiguous":
      return tr`Result unknown`;
  }
}

function toolTone(status: RunToolStatus): string {
  if (status === "failed" || status === "refused") return "text-destructive";
  if (status === "waiting" || status === "ambiguous") return "text-warning";
  if (status === "completed") return "text-success";
  return "";
}

/** Time of day in Shanghai, to the second, for calls within one run. */
function formatClock(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function formatDuration(ms: number, locale: string): string {
  const seconds = ms / 1000;
  return seconds < 60
    ? new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "second",
        unitDisplay: "narrow",
        maximumFractionDigits: 1,
      }).format(seconds)
    : new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "minute",
        unitDisplay: "narrow",
        maximumFractionDigits: 1,
      }).format(seconds / 60);
}

/**
 * The calls a run actually made, read from its persisted record. Shown when a chat's tool card
 * opens: a step count or a finished run never stands in for a call's own outcome.
 */
export function RunToolCalls({ runId }: { runId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const detail = useQuery(
    queries.runs.detail.queryOptions({
      input: { runId },
      refetchInterval: (query) => {
        const data = query.state.data;
        const unsettled =
          !!data &&
          (ACTIVE.has(data.status) ||
            data.toolTrace.calls.some((c) => c.status === "pending" || c.status === "waiting"));
        return poll(unsettled, query.state.error);
      },
    }),
  );
  return (
    <div data-testid="run-tool-calls" className="mt-2 text-sm">
      {detail.isError ? (
        <LoadError error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}
      {detail.data ? (
        <ToolTrace trace={detail.data.toolTrace} />
      ) : detail.isError ? null : (
        <Spinner aria-label={t`Loading…`} />
      )}
    </div>
  );
}

/** A read-only source's safe summary: where the data came from, or why the read failed. */
function ResultSummary({ summary }: { summary: SafeReadonlySourceSummary }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  return (
    <details className="mt-1 text-xs" data-testid="tool-result-summary">
      <summary className="cursor-pointer text-muted-foreground">
        {summary.outcome === "success" ? t`Source details` : t`Error details`}
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {summary.outcome === "success" ? (
          <>
            <dt className="text-muted-foreground">{t`Source`}</dt>
            <dd className="break-all">
              {t`Synthetic`} · {summary.source.sourceId}
            </dd>
            <dt className="text-muted-foreground">{t`Business ID`}</dt>
            <dd className="break-all font-mono">{summary.source.workspaceId}</dd>
            <dt className="text-muted-foreground">{t`Version`}</dt>
            <dd className="break-all">{summary.source.version}</dd>
            <dt className="text-muted-foreground">{t`Generated`}</dt>
            <dd>
              <time dateTime={summary.source.generatedAt}>
                {formatDateTime(summary.source.generatedAt, locale)}
              </time>
            </dd>
            <dt className="text-muted-foreground">{t`Date`}</dt>
            <dd>{summary.date}</dd>
            <dt className="text-muted-foreground">{t`Periods`}</dt>
            <dd>
              <ul>
                {summary.periods.map((period) => (
                  <li key={period.start}>
                    {formatHourMinute(period.start, locale)}–{formatHourMinute(period.end, locale)}{" "}
                    · {formatEnergy(period.forecastMWh, locale)}
                  </li>
                ))}
              </ul>
            </dd>
            <dd className="col-span-2 text-muted-foreground">
              {t`Candidate data only, not recorded as business evidence`}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">{t`Error`}</dt>
            <dd>{sourceErrorText(summary.errorCode)}</dd>
            <dt className="text-muted-foreground">{t`Business ID`}</dt>
            <dd className="break-all font-mono">{summary.workspaceId}</dd>
            <dd className="col-span-2 text-muted-foreground">
              {summary.retryable
                ? t`You can ask again`
                : t`Asking again will not help until this is fixed`}
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

type SourceErrorCode = Extract<SafeReadonlySourceSummary, { outcome: "error" }>["errorCode"];

/** Stable source error codes in the interface language; never the source's own text. */
function sourceErrorText(code: SourceErrorCode): string {
  switch (code) {
    case "INVALID_QUERY":
      return tr`The request was not valid`;
    case "SOURCE_TIMEOUT":
      return tr`The source took too long to answer`;
    case "SOURCE_UNREACHABLE":
      return tr`The source could not be reached`;
    case "SOURCE_INVALID_RESPONSE":
      return tr`The source answered in an unexpected format`;
    case "SOURCE_AUTH_FAILED":
      return tr`The source rejected its configured credential`;
    case "SOURCE_NO_DATA":
      return tr`The source has no data for that request`;
  }
}

/** A period boundary in Shanghai time; periods start on the hour, so seconds add nothing. */
function formatHourMinute(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function formatEnergy(mwh: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(mwh)} MWh`;
}

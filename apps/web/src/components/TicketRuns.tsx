import { t as tr } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RunTraceDetail, RunTraceRow } from "@rakazo/contracts";
import { Button, Spinner } from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { statusLabel, statusTone } from "../pages/ActivityList";
import {
  ACTIVE,
  formatDuration,
  LoadError,
  poll,
  shortCode,
  TIME_ZONE,
  ToolTrace,
} from "./run-tool-trace";

type Cursor = { runId: string; createdAt: string };

/** Runs started for one ticket, newest first, with one run's detail opened in place. */
export function TicketRuns({ ticketId }: { ticketId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const list = useInfiniteQuery(
    queries.runs.forTicket.infiniteOptions({
      input: (cursor: Cursor | null) => ({ ticketId, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as Cursor | null,
      getNextPageParam: (page) => page.nextCursor,
      // Board events refresh the list; polling covers status changes they do not announce.
      refetchInterval: (query) =>
        poll(
          query.state.data?.pages.some((page) => page.runs.some((run) => ACTIVE.has(run.status))) ??
            false,
          query.state.error,
        ),
    }),
  );
  const runs = list.data?.pages.flatMap((page) => page.runs) ?? null;

  return (
    <section data-testid="ticket-runs" className="space-y-2 border-t pt-3 text-sm">
      {openRunId ? (
        <RunDetail runId={openRunId} onBack={() => setOpenRunId(null)} />
      ) : (
        <>
          <h3 className="font-medium">
            <Trans>Runs</Trans>
          </h3>
          {/* A failed refresh says so above whatever was last loaded. */}
          {list.isError ? (
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          ) : null}
          {runs === null ? (
            list.isError ? null : (
              <Spinner aria-label={t`Loading…`} />
            )
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No linked runs recorded</Trans>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.runId}>
                  <RunRow run={run} onOpen={() => setOpenRunId(run.runId)} />
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <Button
              variant="text"
              className="font-normal"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              <Trans>Load older runs</Trans>
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

function RunRow({ run, onOpen }: { run: RunTraceRow; onOpen: () => void }) {
  const { t, i18n } = useLingui();
  const reason = reasonText(run.reason);
  const code = shortCode(run.runId);
  const retried = run.retryOfRunId ? shortCode(run.retryOfRunId) : null;
  const botName = run.botName ?? t`Bot not recorded`;
  const status = statusLabel(run.status);
  const startedAt = formatTime(run.createdAt, i18n.locale);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t`Run ${code}, ${botName}, ${status}, ${startedAt}`}
      className="flex w-full min-w-0 flex-col items-start gap-0.5 py-2 text-left hover:bg-muted/50"
    >
      <span className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="truncate">{botName}</span>
        <span className={`shrink-0 text-xs ${statusTone(run.status)}`}>{status}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        <span className="font-mono">#{code}</span> ·{" "}
        <time dateTime={run.createdAt}>{startedAt}</time>
        {retried ? <> · {t`Retry of #${retried}`}</> : null}
        {reason ? <> · {reason}</> : null}
      </span>
    </button>
  );
}

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const queries = useSpaceQueries();
  const ticketStatuses = useTicketStatusLabels();
  const detail = useQuery(
    queries.runs.detail.queryOptions({
      input: { runId },
      refetchInterval: (query) =>
        poll(query.state.data ? ACTIVE.has(query.state.data.status) : false, query.state.error),
    }),
  );
  const run = detail.data;
  const code = shortCode(runId);
  const retried = run?.retryOfRunId ? shortCode(run.retryOfRunId) : null;
  return (
    <section data-testid="run-detail" aria-label={t`Run ${code}`} className="space-y-3">
      <Button variant="ghost" size="sm" className="-ms-2" onClick={onBack}>
        <ChevronLeft />
        <Trans>All runs</Trans>
      </Button>
      {detail.isError ? (
        <LoadError error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}
      {!run ? (
        detail.isError ? null : (
          <Spinner aria-label={t`Loading…`} />
        )
      ) : (
        <>
          <h4 className="font-medium">
            {t`Run`} <span className="font-mono">#{code}</span>
          </h4>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">
              <Trans>Run ID</Trans>
            </dt>
            <dd className="break-all font-mono text-xs leading-5">{run.runId}</dd>
            <dt className="text-muted-foreground">
              <Trans>Status</Trans>
            </dt>
            <dd className={statusTone(run.status)}>
              {statusLabel(run.status)}
              {reasonText(run.reason) ? ` · ${reasonText(run.reason)}` : null}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Ticket</Trans>
            </dt>
            <dd>
              {run.ticket ? (
                <>
                  {run.ticket.ref} · {ticketStatuses[run.ticket.status]}
                </>
              ) : (
                <span className="text-muted-foreground">
                  <Trans>No ticket link recorded</Trans>
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Bot</Trans>
            </dt>
            <dd className="truncate">
              <Link to={`/app/${run.botId}`} className="underline underline-offset-2">
                {run.botName ?? t`Bot not recorded`}
              </Link>
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Started</Trans>
            </dt>
            <dd>
              <time dateTime={run.createdAt}>{formatTime(run.createdAt, locale)}</time>
              {retried ? ` · ${t`Retry of #${retried}`}` : null}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Duration</Trans>
            </dt>
            <dd>
              {run.timing.durationMs === null
                ? t`Not recorded`
                : formatDuration(run.timing.durationMs, locale)}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Cost</Trans>
            </dt>
            <dd>{costText(run, locale) ?? t`Unknown`}</dd>
          </dl>
          <ToolTrace trace={run.toolTrace} />
        </>
      )}
    </section>
  );
}

/** Waiting reasons repeat the status, so only stops and failures add a reason. */
function reasonText(reason: RunTraceRow["reason"]): string | null {
  switch (reason) {
    case "stopped":
      return tr`Stopped`;
    case "failure":
      return tr`Run failed`;
    case "key":
      return tr`Model key rejected`;
    case "credit":
      return tr`Out of model credit`;
    case "spending":
      return tr`Spending limit reached`;
    case "rate":
      return tr`Model rate limited`;
    case "auth":
      return tr`Model sign-in failed`;
    case "access":
      return tr`No access to the model`;
    case "model":
      return tr`Model unavailable`;
    case "context":
      return tr`Too much context for the model`;
    case "output":
      return tr`Model returned nothing usable`;
    default:
      return null;
  }
}

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** Recorded cost so far; null when any record lacks one, so a gap never reads as zero. */
function costText(run: RunTraceDetail, locale: string): string | null {
  if (!run.usage.costKnown || run.usage.costUsd === null) return null;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(run.usage.costUsd);
}

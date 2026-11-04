import { Trans, useLingui } from "@lingui/react/macro";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { errorText } from "../lib/user-error";
import { BoardPage } from "./Board";

export function BusinessSupervisor() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const statuses = useTicketStatusLabels();
  const { data, error } = useQuery({
    ...queries.businessSupervisor.overview.queryOptions({ input: {} }),
    refetchInterval: 5000,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="business-supervisor">
      <section className="shrink-0 space-y-3 border-b p-4">
        <h1 className="font-medium">
          <Trans>Business overview</Trans>
        </h1>
        {error ? (
          <p role="alert" className="text-destructive">
            {errorText(error)}
          </p>
        ) : data ? (
          <>
            <p>
              <Trans>Completed tasks</Trans>:{" "}
              <strong>
                {data.completed} / {data.total}
              </strong>{" "}
              · {data.completionPercent}%
            </p>
            <progress
              className="h-2 w-full appearance-none overflow-hidden rounded bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
              max={100}
              value={data.completionPercent}
              aria-label={t`Task completion`}
            />
            <div className="flex flex-wrap gap-3 text-sm">
              {TICKET_STATUSES.map((status) => (
                <span key={status}>
                  {statuses[status]}: {data.counts[status]}
                </span>
              ))}
            </div>
            <details>
              <summary className="cursor-pointer text-sm">
                <Trans>Team and recent results</Trans>
              </summary>
              <ul className="mt-2 space-y-2 text-sm">
                {data.team.map((bot) => (
                  <li key={bot.id}>
                    <strong>{bot.name}</strong> · <Trans>Active runs</Trans>: {bot.activeRuns} ·{" "}
                    <Trans>Failed runs (history)</Trans>: {bot.failedRuns}
                  </li>
                ))}
              </ul>
              {data.recentTasks.map((task) =>
                task.latestComment ? (
                  <article className="mt-3 rounded border p-3 text-sm" key={task.id}>
                    <strong>
                      {task.ref} · {task.title}
                    </strong>
                    <p className="mt-1 whitespace-pre-wrap">{task.latestComment}</p>
                  </article>
                ) : null,
              )}
            </details>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        )}
      </section>
      <div className="min-h-96 flex-1">
        <BoardPage embedded />
      </div>
    </div>
  );
}

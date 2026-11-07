import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { formatCompactDuration } from "@rakazo/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { RunToolCalls } from "./run-tool-trace";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const isCurrent = index === currentIndex;
        return (
          <Fragment key={index}>
            {step.note ? (
              <div className="py-1 text-[13px] text-foreground/75" data-testid="tool-step-note">
                <ChatMarkdown>{step.note}</ChatMarkdown>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2 leading-5">
              {/* A step says a tool was used, not that it worked; outcomes come from the run's record. */}
              <span
                aria-hidden
                className={`text-[12px] ${isCurrent ? "text-warning" : "text-muted-foreground"}`}
                style={{ animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
              >
                {isCurrent ? "◷" : "•"}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] ${
                  isCurrent ? "text-foreground" : "text-muted-foreground"
                }`}
                title={step.label}
              >
                {step.label}
                {step.count > 1 ? ` ×${step.count}` : ""}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The tool-activity card. It starts open while the run is live and folds when the run
 * ends. The keyed default keeps manual toggles until the run changes phase.
 */
export function ToolActivityDisclosure({
  live,
  durationMs,
  runId,
  children,
}: {
  live: boolean;
  durationMs?: number;
  /** The message's run, whose recorded calls show each tool's actual outcome once opened. */
  runId?: string;
  children: ReactNode;
}) {
  const duration = formatCompactDuration(durationMs);
  // The run's record is read only once someone opens a finished card.
  const [opened, setOpened] = useState(false);
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      defaultOpen={live}
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <CollapsibleTrigger
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex items-center gap-2">
          {/* Neutral on purpose: steps are not calls, and a finished run is not a successful one.
              Each call's outcome is in the run's record below. */}
          <span>{live ? <Trans>Working…</Trans> : <Trans>Tool activity</Trans>}</span>
          {!live && duration ? <span>{duration}</span> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="ms-[7px] mt-0.5 border-s border-border ps-3">
          {children}
          {runId && opened && !live ? <RunToolCalls runId={runId} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  steps,
  durationMs,
  runId,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  durationMs?: number;
  runId?: string;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="max-w-full min-w-0 ps-1">
        <ToolActivityDisclosure live={live} durationMs={durationMs} runId={runId}>
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
  runId,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
  runId?: string;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "steps" ? (
          <StandaloneToolActivity
            key={i}
            live={live}
            steps={block.steps}
            durationMs={block.durationMs}
            runId={i === blocks.findLastIndex((b) => b.kind === "steps") ? runId : undefined}
          />
        ) : null,
      )}
    </>
  );
}

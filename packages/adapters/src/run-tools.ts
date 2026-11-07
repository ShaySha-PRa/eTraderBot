import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import type { RunToolStatus } from "@rakazo/contracts";
import { toolResultTaintsRun } from "@rakazo/core";
import { requireIsolatedBot } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  isInternalTermination,
  isTerminatingReplyResult,
  isToolPauseResult,
} from "./approval-effect.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import { tradingTools } from "./run-tools-trading.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { toolResultError } from "./tool-result-error.js";
import { argumentGiven } from "./update-bot-patch.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(tradingTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  // Known identifiers only, never model-supplied payloads or unknown tool-name text.
  const traceName =
    TOOL_HANDLERS.has(name) ||
    ctx.tools.connector.has(name) ||
    ctx.tools.offered?.some((tool) => tool.name === name)
      ? name
      : "unknown_tool";
  const trace = await ctx.deps.prisma.runToolCall.upsert({
    where: { attemptId_executionId: { attemptId: ctx.attempt.id, executionId } },
    create: {
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      runId: ctx.runId,
      attemptId: ctx.attempt.id,
      executionId,
      name: traceName,
      status: "pending",
    },
    update: {},
    select: { id: true },
  });
  let dispatched = false;
  let status: RunToolStatus = "ambiguous";
  try {
    const result = await dispatchTool(ctx, name, args, executionId, observer, () => {
      dispatched = true;
    });
    status = toolTraceStatus(result, dispatched);
    return result;
  } catch (error) {
    // A thrown call may already have reached an external destination; do not claim rollback.
    status = dispatched ? "ambiguous" : "refused";
    throw error;
  } finally {
    // Never turn a completed side effect into a retry because its summary write failed.
    await ctx.deps.prisma.runToolCall
      .updateMany({
        where: { id: trace.id, status: "pending" },
        data: { status, finishedAt: new Date() },
      })
      .catch(() =>
        getLogger().warn("run.tool_trace_finish_failed", {
          runId: ctx.runId,
          toolCallId: trace.id,
        }),
      );
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

function toolTraceStatus(result: unknown, dispatched: boolean): RunToolStatus {
  if (isInternalTermination(result) && isToolPauseResult(result)) return "waiting";
  if (result && typeof result === "object") {
    if ("uncertain" in result && result.uncertain === true) return "ambiguous";
    if ("code" in result && ["FORBIDDEN", "WORKSPACE_ISOLATION"].includes(String(result.code)))
      return "refused";
  }
  if (isTerminatingReplyResult(result)) return "refused";
  if (toolResultError(result) !== undefined) return dispatched ? "failed" : "refused";
  return "completed";
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
  onDispatch: () => void,
) {
  ctx.context.signal.throwIfAborted();
  const persisted = await requireIsolatedBot(ctx.deps.prisma, {
    spaceId: ctx.run.spaceId,
    userId: ctx.run.userId,
    botId: ctx.bot.id,
  });
  // A host desktop can carry another workspace's files and authenticated browser sessions.
  // General Bots use the workspace's isolated computer, never the user's host session.
  if (
    !persisted.tradingRole &&
    ([USER_COMPUTER_SHELL_TOOL, USER_COMPUTER_OBSERVE_TOOL, USER_COMPUTER_ACT_TOOL].includes(
      name,
    ) ||
      persisted.computer?.kind === "desktop")
  )
    return {
      error:
        "General Bots require a workspace-isolated computer; host computer access is unavailable",
      code: "WORKSPACE_ISOLATION",
    };
  if (ctx.state.handedOff) {
    return {
      error: "This stage was handed off. End the turn without more tool calls.",
    };
  }
  if (ctx.tools.disabled.has(name)) {
    return { error: "This tool is disabled for this bot." };
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return { error: "Page browser is unavailable on this computer." };
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) return gate.result;
  onDispatch();
  if (!gate.call.applied) return toolHandler(gate.call.name)(ctx, gate.call);
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await toolHandler(gate.call.name)(ctx, gate.call);
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
    });
  }
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  return isTerminatingReplyResult(result);
}

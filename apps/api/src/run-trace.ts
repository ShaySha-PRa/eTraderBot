import { ORPCError } from "@orpc/server";
import type { Actor, RpcInput, RunTraceDetail, RunTraceRow } from "@rakazo/contracts";
import { RunToolStatusSchema, RunTraceRowSchema, TicketStatusSchema } from "@rakazo/contracts";
import { normalizeRunError, safeReadonlySourceSummary } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

const traceSelect = {
  id: true,
  taskId: true,
  botId: true,
  threadId: true,
  status: true,
  trigger: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  retryOfRunId: true,
  error: true,
  bot: { select: { name: true } },
} satisfies Prisma.RunSelect;
type TraceRow = Prisma.RunGetPayload<{ select: typeof traceSelect }>;
const missing = () => new ORPCError("NOT_FOUND", { data: { reason: "NOT_FOUND" } });

async function requireMembership(prisma: PrismaClient, actor: Actor) {
  const membership = await prisma.spaceMember.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, space: { deletingAt: null } },
    select: { id: true },
  });
  if (!membership) throw new ORPCError("FORBIDDEN", { data: { reason: "FORBIDDEN" } });
}
function rowDto(row: TraceRow): RunTraceRow {
  return RunTraceRowSchema.parse({
    runId: row.id,
    taskId: row.taskId,
    botId: row.botId,
    botName: row.bot?.name ?? null,
    threadId: row.threadId,
    status: row.status,
    trigger: row.trigger,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    retryOfRunId: row.retryOfRunId,
    reason:
      row.status === "waiting_input" || row.status === "waiting_takeover"
        ? row.status
        : row.status === "cancelled"
          ? "stopped"
          : row.error
            ? (normalizeRunError(row.error).kind ?? "failure")
            : null,
  });
}
function elapsed(end: Date | null, start: Date | null) {
  return end && start ? Math.max(0, end.getTime() - start.getTime()) : null;
}

export async function runsForTicket(
  prisma: PrismaClient,
  actor: Actor,
  input: RpcInput<"runs/forTicket">,
) {
  await requireMembership(prisma, actor);
  const ticket = await prisma.ticket.findFirst({
    where: { id: input.ticketId, spaceId: actor.spaceId },
    select: { id: true },
  });
  if (!ticket) throw missing();
  const limit = input.limit ?? 20;
  const cursor = input.cursor;
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      task: { ticketId: ticket.id, spaceId: actor.spaceId, userId: actor.userId },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.runId } },
            ],
          }
        : {}),
    },
    select: traceSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const runs = rows.slice(0, limit).map(rowDto);
  const last = runs.at(-1);
  return {
    runs,
    nextCursor:
      rows.length > limit && last ? { runId: last.runId, createdAt: last.createdAt } : null,
  };
}

export async function runTraceDetail(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
): Promise<RunTraceDetail> {
  await requireMembership(prisma, actor);
  const row = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      ...traceSelect,
      leaseFence: true,
      firstResponseAt: true,
      toolTraceVersion: true,
      task: { select: { ticketId: true } },
    },
  });
  if (!row) throw missing();
  const scope = { spaceId: actor.spaceId, userId: actor.userId, runId };
  const [ticket, records, calls] = await Promise.all([
    row.task.ticketId
      ? prisma.ticket.findFirst({
          where: { id: row.task.ticketId, spaceId: actor.spaceId },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            board: { select: { ticketPrefix: true } },
          },
        })
      : null,
    prisma.usageRecord.findMany({
      where: scope,
      select: { totalTokens: true, costUsd: true, currency: true },
    }),
    prisma.runToolCall.findMany({
      where: scope,
      include: { attempt: { select: { status: true, fence: true } } },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: 201,
    }),
  ]);
  const costKnown =
    records.length > 0 &&
    records.every((r) => r.costUsd !== null && r.currency.toLowerCase() === "usd");
  const tokensKnown = records.length > 0 && records.every((r) => r.totalTokens !== null);
  return {
    ...rowDto(row),
    ticket: ticket
      ? {
          id: ticket.id,
          ref: `${ticket.board.ticketPrefix}-${ticket.number}`,
          title: ticket.title,
          status: TicketStatusSchema.parse(ticket.status),
        }
      : null,
    waiting:
      row.status === "waiting_input"
        ? { kind: "input" }
        : row.status === "waiting_takeover"
          ? { kind: "takeover" }
          : null,
    timing: {
      queuedMs: elapsed(row.startedAt, row.createdAt),
      durationMs: elapsed(row.completedAt, row.startedAt),
      firstResponseMs: elapsed(row.firstResponseAt, row.createdAt),
    },
    usage: {
      recordCount: records.length,
      totalTokens: tokensKnown ? records.reduce((sum, r) => sum + r.totalTokens!, 0) : null,
      costUsd: costKnown ? records.reduce((sum, r) => sum + r.costUsd!, 0) : null,
      costKnown,
    },
    toolTrace: {
      recorded: row.toolTraceVersion === 1,
      truncated: calls.length > 200,
      calls: calls.slice(0, 200).map((call) => {
        const status =
          call.status === "pending" &&
          (["completed", "failed", "cancelled"].includes(row.status) ||
            call.attempt.status !== "running" ||
            call.attempt.fence !== row.leaseFence)
            ? "ambiguous"
            : RunToolStatusSchema.parse(call.status);
        return {
          id: call.id,
          attemptId: call.attemptId,
          name: call.name,
          status,
          resultSummary: safeReadonlySourceSummary(call.resultSummary, actor.spaceId, status),
          startedAt: call.startedAt.toISOString(),
          finishedAt: call.finishedAt?.toISOString() ?? null,
          durationMs: elapsed(call.finishedAt, call.startedAt),
        };
      }),
    },
  };
}

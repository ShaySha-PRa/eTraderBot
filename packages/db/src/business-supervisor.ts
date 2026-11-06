import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { BusinessOverviewSchema, initialBotMemory } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, tradingAssert } from "@rakazo/core";
import { ensureBoard, toTicketDto } from "./board.js";
import type { Prisma, PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";
import { requireIsolatedBot, requireWorkspaceKind } from "./workspace-isolation.js";

const instructions = [
  "You coordinate this business workspace. Use business_overview to discover its specialist Bots, task counts, blockers, recent results and failed runs.",
  "Use business_cycle list/read to read shared business evidence and market rules. For cycle work, use business_cycle assign: contract questions normally need only contract_coverage; spot analysis reads existing contracts and forecasts and requests contract or risk assistance only when needed. Settlement review waits for clearing, delivery, metering and settlement. Use dependsOn for dependent tasks; independent tasks may run concurrently. Never wake every role by default or generate four fixed answers. Preserve source IDs, rule versions, disagreements and unresolved issues. Specialist results use business_cycle complete. For other tasks use tickets.",
  "Break the user's request into clear tasks with deliverables. Use ticket_create with ownerBotId to delegate to an existing specialist in this workspace; assignment wakes that Bot. Keep progress and results in tickets and comments; ticket_get reads full details. Use ticket_update for status changes and reassignments.",
  "Do not equate a finished model run with completed work. Completion percentage is derived from persisted ticket status done; closed means won't do and is not successful completion, not an estimate. Summarize evidence, unresolved blockers, pending reviews and next actions. Do not mark tasks complete without the assignee's result or user confirmation.",
  "You have no trading role, algorithm approval, trade approval or execution permission. Never execute orders, approve a trade, change limits or route around a denied operation. The four specialist roles retain their independent scope and human approval checks. Never delegate outside this workspace.",
].join("\n\n");

/** Called inside the workspace transaction. Idempotent provisioning never rehomes existing Bots. */
export async function ensureBusinessSupervisor(tx: Prisma.TransactionClient, spaceId: string) {
  await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE "spaceId"=${spaceId} FOR UPDATE`;
  const workspace = await tx.tradingWorkspace.findUnique({ where: { spaceId } });
  if (!workspace) return null;
  await requireWorkspaceKind(tx, spaceId, "trading");
  const prior = await tx.bot.findFirst({ where: { spaceId, businessSupervisor: true } });
  if (prior) return prior;
  const id = randomUUID(),
    userId = workspace.ownerUserId;
  const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
  const configured = process.env.SANDBOX_PROVIDER ?? "docker";
  const kind =
    configured === "docker" && settings?.computerHost === "this-mac" ? "desktop" : configured;
  const computer = await ensureComputerRecord(tx, { mode: "team", spaceId, userId, kind });
  const bot = await tx.bot.create({
    data: {
      id,
      spaceId,
      userId,
      businessSupervisor: true,
      name: "业务主管",
      description: "Business task coordination and progress",
      instructions,
      color: "blue",
      pinned: true,
      position: -1,
      crossSpaceCommunication: false,
      computerId: computer.id,
    },
  });
  await tx.thread.create({ data: { spaceId, userId, botId: id } });
  await tx.browserProfile.create({ data: { spaceId, userId, botId: id } });
  await tx.memoryDocument.create({
    data: {
      spaceId,
      userId,
      botId: id,
      scope: "bot",
      path: "MEMORY.md",
      content: initialBotMemory(bot.name),
    },
  });
  return bot;
}

export async function businessOverview(
  prisma: PrismaClient,
  identity: Pick<Actor, "spaceId" | "userId"> & { botId?: string },
) {
  await requireWorkspaceKind(prisma, identity.spaceId, "trading");
  const workspace = await prisma.tradingWorkspace.findFirst({
    where: {
      spaceId: identity.spaceId,
      ownerUserId: identity.userId,
      space: { memberships: { some: { userId: identity.userId } } },
    },
  });
  tradingAssert(
    workspace,
    "FORBIDDEN",
    "Business overview is only available to its owner and supervisor",
  );
  if (identity.botId) {
    const bot = await requireIsolatedBot(prisma, { ...identity, botId: identity.botId });
    tradingAssert(
      bot.businessSupervisor,
      "FORBIDDEN",
      "Only the business supervisor can aggregate this workspace",
    );
  }
  const supervisor = await prisma.$transaction((tx) =>
    ensureBusinessSupervisor(tx, identity.spaceId),
  );
  tradingAssert(supervisor, "NOT_FOUND", "Business supervisor unavailable");
  const board = await ensureBoard(prisma, identity.spaceId);
  const [groups, bots, recentTasks] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["status"],
      where: { spaceId: identity.spaceId, boardId: board.id },
      _count: true,
    }),
    prisma.bot.findMany({
      where: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        archivedAt: null,
        tradingRole: { not: null },
      },
      select: { id: true, name: true, tradingRole: true },
    }),
    prisma.ticket.findMany({
      where: { spaceId: identity.spaceId, boardId: board.id },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 30,
      include: { comments: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
  ]);
  const counts = { todo: 0, doing: 0, review: 0, blocked: 0, done: 0, closed: 0 };
  for (const group of groups)
    if (group.status in counts) counts[group.status as keyof typeof counts] = group._count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0),
    completed = counts.done;
  const runs = await prisma.run.groupBy({
    by: ["botId", "status"],
    where: { spaceId: identity.spaceId, botId: { in: bots.map((b) => b.id) } },
    _count: true,
  });
  return BusinessOverviewSchema.parse({
    spaceId: identity.spaceId,
    supervisorId: supervisor.id,
    counts,
    total,
    completed,
    completionPercent: total ? Math.round((completed / total) * 100) : 0,
    team: bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.tradingRole,
      activeRuns: runs
        .filter(
          (r) => r.botId === bot.id && ACTIVE_RUN_STATUSES.some((status) => status === r.status),
        )
        .reduce((n, r) => n + r._count, 0),
      failedRuns: runs
        .filter((r) => r.botId === bot.id && r.status === "failed")
        .reduce((n, r) => n + r._count, 0),
    })),
    recentTasks: recentTasks.map((task) => ({
      ...toTicketDto(task, board.ticketPrefix),
      latestComment: task.comments[0]?.body ?? null,
    })),
  });
}

export async function ticketBoardAvailable(
  prisma: PrismaClient,
  spaceId: string,
  enabled?: boolean,
) {
  if (enabled) return true;
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { kind: true, isolationPending: true, deletingAt: true },
  });
  return space?.kind === "trading" && !space.isolationPending && !space.deletingAt;
}

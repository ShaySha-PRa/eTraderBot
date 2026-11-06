import type { BusinessEvidence, BusinessWorkKind } from "@rakazo/contracts";
import { BusinessWorkResultSchema, BusinessWorkSchema } from "@rakazo/contracts";
import {
  businessEvidenceBlockers,
  businessWorkRequirements,
  businessWorkStartEvidence,
  currentBusinessEvidence,
  tradingAssert,
} from "@rakazo/core";
import { businessIdentity, cycleEvidence } from "./business-cycle-evidence.js";
import type { BusinessCycleWork, Prisma, PrismaClient, Ticket } from "./client.js";
import { Prisma as PrismaRuntime } from "./client.js";
import { currentDbContext } from "./row-security.js";
import { requireIsolatedBot } from "./workspace-isolation.js";

type Db = Prisma.TransactionClient | PrismaClient;
export type BusinessTicketChange = {
  spaceId: string;
  boardId: string;
  ticketId: string;
  assigneeBotId: string | null;
  wakeAssignee: boolean;
};
export type BusinessTicketNotifier = (change: BusinessTicketChange) => Promise<void>;
const dependencies = (work: BusinessCycleWork) =>
  Array.isArray(work.dependsOn)
    ? work.dependsOn.filter((id): id is string => typeof id === "string")
    : [];
export async function businessWorkBlockers(
  db: Db,
  work: BusinessCycleWork,
  evidence: BusinessEvidence[],
  phase: "start" | "complete" = "start",
) {
  const kind = work.kind as BusinessWorkKind;
  const required =
    phase === "start" ? businessWorkStartEvidence(kind) : businessWorkRequirements[kind].evidence;
  const blockers = businessEvidenceBlockers(
    evidence,
    required,
    phase === "complete" || kind !== "settlement_review",
  ).map((key) => `evidence:${key}`);
  const deps = dependencies(work);
  if (deps.length) {
    const ready = await db.businessCycleWork.findMany({
      where: {
        cycleId: work.cycleId,
        ticketId: { in: deps },
        resultEvidenceId: { not: null },
        ticket: { status: "done" },
      },
    });
    const current = currentBusinessEvidence(evidence);
    blockers.push(
      ...deps
        .filter(
          (id) =>
            !ready.some(
              (r) => r.ticketId === id && current.some((e) => e.id === r.resultEvidenceId),
            ),
        )
        .map((id) => `task:${id}`),
    );
  }
  return blockers;
}
export async function cycleWorkState(db: Db, cycleId: string, evidence: BusinessEvidence[]) {
  const work = await db.businessCycleWork.findMany({
    where: { cycleId },
    include: { ticket: { include: { board: true } } },
    orderBy: { ticket: { number: "asc" } },
  });
  return Promise.all(
    work.map(async (row) =>
      BusinessWorkSchema.parse({
        ticketId: row.ticketId,
        ref: `${row.ticket.board.ticketPrefix}-${row.ticket.number}`,
        kind: row.kind,
        assigneeBotId: row.ticket.assigneeBotId,
        status: row.ticket.status,
        dependsOn: dependencies(row),
        requiredEvidence: businessWorkRequirements[row.kind as BusinessWorkKind].evidence,
        blockers: [
          ...(await businessWorkBlockers(db, row, evidence, "complete")),
          ...(!row.ticket.assigneeBotId && !["done", "closed"].includes(row.ticket.status)
            ? ["assignee:missing"]
            : []),
        ],
        startBlockers: [
          ...(await businessWorkBlockers(db, row, evidence)),
          ...(!row.ticket.assigneeBotId ? ["assignee:missing"] : []),
        ],
        result: row.result ? BusinessWorkResultSchema.parse(row.result) : null,
      }),
    ),
  );
}

/** Evidence changes resume only the affected ready tickets via the existing wake notifier. */
export async function reconcileBusinessWork(
  db: Db,
  cycleId: string,
  changedTicketIds: string[] = [],
): Promise<BusinessTicketChange[]> {
  await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${cycleId} FOR UPDATE`;
  const evidence = await cycleEvidence(db, cycleId),
    current = currentBusinessEvidence(evidence);
  const work = await db.businessCycleWork.findMany({
    where: { cycleId },
    include: { ticket: true },
    orderBy: { ticket: { number: "asc" } },
  });
  const changes: BusinessTicketChange[] = [];
  for (const row of work) {
    let changed = changedTicketIds.includes(row.ticketId);
    let status = row.ticket.status;
    let wakeAssignee = false;
    if (status !== "closed") {
      const blockers = await businessWorkBlockers(db, row, evidence);
      const stale = Boolean(
        row.resultEvidenceId && !current.some((e) => e.id === row.resultEvidenceId),
      );
      const invalidate = stale || Boolean(row.resultEvidenceId && blockers.length);
      let dispatched = row.dispatched;
      if (invalidate) {
        await db.businessCycleWork.update({
          where: { ticketId: row.ticketId },
          data: { result: PrismaRuntime.DbNull, resultEvidenceId: null, dispatched: false },
        });
        dispatched = false;
        changed = true;
      }
      // Deletion/archival never invalidates a completed result's historical authorship.
      const assignee = row.ticket.assigneeBotId
        ? await db.bot.findFirst({
            where: {
              id: row.ticket.assigneeBotId,
              spaceId: row.ticket.spaceId,
              userId: row.ticket.createdByUserId ?? undefined,
              archivedAt: null,
              tradingRole: businessWorkRequirements[row.kind as BusinessWorkKind].role,
            },
            select: { id: true },
          })
        : null;
      if (blockers.length || (!assignee && (status !== "done" || invalidate))) {
        status = "blocked";
        dispatched = false;
      } else if (invalidate || (status === "blocked" && !dispatched)) {
        status = "todo";
        dispatched = false;
      }
      if (dispatched !== row.dispatched)
        await db.businessCycleWork.update({
          where: { ticketId: row.ticketId },
          data: { dispatched },
        });
      if (status !== row.ticket.status) {
        changed = true;
        await db.ticket.update({
          where: { id: row.ticketId },
          data: { status, completedAt: null },
        });
      }
      wakeAssignee = Boolean(
        assignee && !blockers.length && !dispatched && status !== "done" && status !== "blocked",
      );
    }
    if (changed || wakeAssignee)
      changes.push({
        spaceId: row.ticket.spaceId,
        boardId: row.ticket.boardId,
        ticketId: row.ticketId,
        assigneeBotId: row.ticket.assigneeBotId,
        wakeAssignee,
      });
  }
  return changes;
}

/** Shared ticket update gate for RPC and tool calls; completion uses a versioned result. */
export async function guardBusinessTicketUpdate(
  db: Db,
  ticketId: string,
  input: { botId?: string; status?: string; assigneeBotId?: string },
) {
  let work = await db.businessCycleWork.findUnique({
    where: { ticketId },
    include: { ticket: true },
  });
  if (!work) return null;
  await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${work.cycleId} FOR UPDATE`;
  work = await db.businessCycleWork.findUniqueOrThrow({
    where: { ticketId },
    include: { ticket: true },
  });
  const context = currentDbContext();
  tradingAssert(
    context?.kind === "tenant",
    "FORBIDDEN",
    "Business task updates require a tenant identity",
  );
  tradingAssert(
    context.spaceId === work.ticket.spaceId,
    "FORBIDDEN",
    "Task belongs to another business",
  );
  const who = { spaceId: work.ticket.spaceId, userId: context.userId, botId: input.botId };
  const { bot } = await businessIdentity(db, who);
  if (input.botId) {
    tradingAssert(
      bot?.businessSupervisor || input.botId === work.ticket.assigneeBotId,
      "FORBIDDEN",
      "Only the assigned specialist or supervisor can manage this task",
    );
  }
  if (input.assigneeBotId && input.assigneeBotId !== work.ticket.assigneeBotId) {
    const former = work.ticket.assigneeBotId
      ? await db.bot.findUnique({ where: { id: work.ticket.assigneeBotId } })
      : null;
    tradingAssert(
      !former || former.archivedAt,
      "FORBIDDEN",
      "Only a missing or archived business task assignee can be replaced",
    );
    tradingAssert(
      !bot || bot.businessSupervisor,
      "FORBIDDEN",
      "Only the owner or business supervisor can recover an assignee",
    );
    const replacement = await requireIsolatedBot(db, { ...who, botId: input.assigneeBotId });
    tradingAssert(
      replacement.tradingRole === businessWorkRequirements[work.kind as BusinessWorkKind].role &&
        !replacement.businessSupervisor,
      "FORBIDDEN",
      "Replacement must have this task's specialist role in the same business",
    );
    if (!["done", "closed"].includes(work.ticket.status))
      await db.businessCycleWork.update({ where: { ticketId }, data: { dispatched: false } });
  }
  if (input.status && ["doing", "review", "done"].includes(input.status)) {
    const rows = await cycleEvidence(db, work.cycleId);
    tradingAssert(
      (await businessWorkBlockers(db, work, rows, input.status === "done" ? "complete" : "start"))
        .length === 0,
      "MISSING_EVIDENCE",
      "Task is waiting for required evidence or dependencies",
    );
    if (input.status === "done")
      tradingAssert(
        work.resultEvidenceId &&
          BusinessWorkResultSchema.parse(work.result).unresolved.length === 0 &&
          currentBusinessEvidence(rows).some((row) => row.id === work.resultEvidenceId),
        "MISSING_EVIDENCE",
        "Submit a sourced result through business_cycle.complete first",
      );
  }
  return work.cycleId;
}

/** Once per readiness transition, atomically with the existing Task/Run insert. */
export async function claimBusinessTicketWake(db: Db, ticket: Ticket) {
  const work = await db.businessCycleWork.findUnique({ where: { ticketId: ticket.id } });
  if (!work) return true;
  await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${work.cycleId} FOR UPDATE`;
  const current = await db.ticket.findUnique({ where: { id: ticket.id } });
  if (
    !current ||
    current.assigneeBotId !== ticket.assigneeBotId ||
    ["done", "closed"].includes(current.status)
  )
    return false;
  if ((await businessWorkBlockers(db, work, await cycleEvidence(db, work.cycleId))).length)
    return false;
  const claim = await db.businessCycleWork.updateMany({
    where: { ticketId: ticket.id, dispatched: false },
    data: { dispatched: true },
  });
  return claim.count === 1;
}

/** Restore retries enter the same ticket notifier and atomic dispatch path as new evidence. */
export async function resumeBusinessBotWork(db: Db, spaceId: string, botId: string) {
  const work = await db.businessCycleWork.findMany({
    where: { ticket: { spaceId, assigneeBotId: botId, status: { notIn: ["done", "closed"] } } },
    select: { cycleId: true },
  });
  const changes: BusinessTicketChange[] = [];
  for (const cycleId of [...new Set(work.map((row) => row.cycleId))].sort())
    changes.push(...(await reconcileBusinessWork(db, cycleId)));
  return changes;
}

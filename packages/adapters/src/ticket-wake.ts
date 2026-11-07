import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { claimBusinessTicketWake, ticketBoardAvailable } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; ticketBoardEnabled?: boolean },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  if (!(await ticketBoardAvailable(deps.prisma, input.spaceId, deps.ticketBoardEnabled))) return;
  const run = await deps.prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findFirst({
      where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
      include: { board: { select: { ticketPrefix: true } } },
    });
    if (!ticket) return null;
    const status = TicketStatusSchema.safeParse(ticket.status);
    if (!status.success || isTicketCompletedStatus(status.data)) return null;
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
      select: { id: true, userId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return null;
    // A claim is meaningful only when this transaction can create its Task and Run.
    if (!(await claimBusinessTicketWake(tx, ticket))) return null;
    const businessWork = await tx.businessCycleWork.findUnique({
      where: { ticketId: ticket.id },
      select: { cycleId: true },
    });
    // The replacement has its own chat. Give it the durable cycle association,
    // not a stale copy of the former Bot's conversation or editable description.
    const continuation = businessWork
      ? ` Use business_cycle read with cycleId ${businessWork.cycleId} before continuing. Read the latest evidence and prior results, including unresolved issues and historical reviews. Submit with the current expectedResultEvidenceId. Changing assignee grants no credentials, algorithm approval or trading authority.`
      : "";
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        ticketId: ticket.id,
        prompt: `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.${continuation}`,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        taskId: task.id,
        trigger: "tickets",
        status: "queued",
      },
    });
  });
  if (!run) return;
  await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
}

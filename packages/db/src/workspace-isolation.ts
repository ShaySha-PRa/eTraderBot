import type { TradingBotRole } from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

type Db = PrismaClient | Prisma.TransactionClient;
export type WorkspaceKind = "general" | "trading";

export async function requireWorkspaceKind(db: Db, spaceId: string, kind: WorkspaceKind) {
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: { kind: true, isolationPending: true, deletingAt: true },
  });
  tradingAssert(space && !space.deletingAt, "NOT_FOUND", "Workspace not found");
  tradingAssert(
    !space.isolationPending,
    "WORKSPACE_MIGRATION_REQUIRED",
    "This workspace needs its legacy Bot ownership resolved before continuing",
  );
  tradingAssert(
    space.kind === kind,
    "WORKSPACE_KIND_MISMATCH",
    kind === "trading"
      ? "Trading templates and resources require a trading workspace"
      : "General Bots require a general workspace",
  );
  return space;
}
export async function requireBotWorkspace(
  db: Db,
  spaceId: string,
  role?: TradingBotRole | string | null,
  businessSupervisor = false,
) {
  return requireWorkspaceKind(db, spaceId, role || businessSupervisor ? "trading" : "general");
}
/** Recheck persisted identity at run and tool boundaries; model arguments never supply a role. */
export async function requireIsolatedBot(
  db: Db,
  identity: { spaceId: string; userId: string; botId: string },
) {
  const bot = await db.bot.findFirst({
    where: {
      id: identity.botId,
      spaceId: identity.spaceId,
      userId: identity.userId,
      archivedAt: null,
      space: { deletingAt: null, memberships: { some: { userId: identity.userId } } },
    },
    include: { computer: { select: { spaceId: true, userId: true, kind: true } } },
  });
  tradingAssert(bot, "FORBIDDEN", "Bot is unavailable in this workspace");
  await requireBotWorkspace(db, bot.spaceId, bot.tradingRole, bot.businessSupervisor);
  tradingAssert(
    !bot.computer ||
      (bot.computer.spaceId === identity.spaceId && bot.computer.userId === identity.userId),
    "FORBIDDEN",
    "Bot computer belongs to another workspace",
  );
  tradingAssert(
    bot.tradingRole || bot.computer?.kind !== "desktop",
    "FORBIDDEN",
    "General Bots require a workspace-isolated computer; host computer access is unavailable",
  );
  return bot;
}

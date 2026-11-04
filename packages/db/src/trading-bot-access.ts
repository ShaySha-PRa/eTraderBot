import type { TradingBotIdentity } from "@rakazo/adapter-kit";
import { TradingDeskSchema } from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { requireIsolatedBot } from "./workspace-isolation.js";

export async function checkTradingBot(
  db: Prisma.TransactionClient | PrismaClient,
  identity: TradingBotIdentity,
  deskId: string,
  write = false,
) {
  await requireIsolatedBot(db, identity);
  const desk = await db.tradingDesk.findFirst({
    where: { id: deskId, spaceId: identity.spaceId, ownerUserId: identity.userId },
  });
  const bot = await db.bot.findFirst({
    where: {
      id: identity.botId,
      spaceId: identity.spaceId,
      userId: identity.userId,
      archivedAt: null,
    },
  });
  const binding = await db.tradingBotBinding.findFirst({
    where: { deskId, botId: identity.botId },
  });
  tradingAssert(
    desk && bot?.tradingRole && binding && binding.role === bot.tradingRole,
    "FORBIDDEN",
    "Bot is not assigned to this trading scope",
  );
  const scope = TradingDeskSchema.shape.scope.parse(desk.scope);
  if (write)
    tradingAssert(
      (binding.role === "mid_long_term" && scope.stage === "mid_long_term") ||
        (binding.role === "spot" && scope.stage !== "mid_long_term"),
      "FORBIDDEN",
      "Bot role cannot act in this trading stage",
    );
  return { desk, scope, binding };
}

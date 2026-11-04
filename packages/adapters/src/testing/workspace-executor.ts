import type { PrismaClient } from "@rakazo/db";
import { createRunExecutor as createExecutor } from "../executor.js";

/** Complete the identity rows in executor unit fixtures. Isolation itself is exercised through
 * real PostgreSQL/RPC/tool tests, not this synthetic model/computer lifecycle fixture. */
export function createRunExecutor(
  deps: Parameters<typeof createExecutor>[0],
  kind: "general" | "trading" = "general",
) {
  const prisma = new Proxy(deps.prisma, {
    get(target, model, receiver) {
      if (model === "bot")
        return new Proxy(target.bot ?? {}, {
          get(bot, method) {
            if (method !== "findFirst") return Reflect.get(bot, method);
            return (args: {
              where: { id: string; spaceId: string; userId: string };
              include?: { computer?: { select?: { spaceId?: boolean } } };
            }) => {
              if (args.include?.computer?.select?.spaceId)
                return Promise.resolve({
                  ...args.where,
                  tradingRole: kind === "trading" ? "spot" : null,
                  computer: null,
                });
              return target.bot.findFirst(args);
            };
          },
        });
      if (model === "space")
        return new Proxy(target.space ?? {}, {
          get(space, method) {
            if (method !== "findUnique") return Reflect.get(space, method);
            return (args: { select?: { kind?: boolean } }) =>
              args.select?.kind
                ? Promise.resolve({ kind, isolationPending: false, deletingAt: null })
                : target.space.findUnique(args as never);
          },
        });
      return Reflect.get(target, model, receiver);
    },
  }) as PrismaClient;
  return createExecutor({ ...deps, prisma });
}

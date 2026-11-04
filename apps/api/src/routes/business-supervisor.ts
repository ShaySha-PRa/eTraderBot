import { ORPCError } from "@orpc/server";
import { TradingError } from "@rakazo/core";
import { businessOverview } from "@rakazo/db";
import type { RouterContext } from "./context.js";

export function businessSupervisorRoutes(ctx: RouterContext) {
  return {
    businessSupervisor: {
      overview: ctx.authed.businessSupervisor.overview.handler(async ({ context }) => {
        try {
          return await businessOverview(ctx.deps.prisma, context.actor);
        } catch (error) {
          if (error instanceof TradingError)
            throw new ORPCError("FORBIDDEN", { message: error.message });
          throw error;
        }
      }),
    },
  };
}

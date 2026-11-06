import { ORPCError } from "@orpc/server";
import { TradingError } from "@rakazo/core";
import { createBusinessCycleService } from "@rakazo/db";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import type { RouterContext } from "./context.js";

export function businessCycleRoutes(ctx: RouterContext) {
  const service = createBusinessCycleService(
    ctx.deps.prisma,
    ctx.deps.tradingClock,
    ctx.deps.ticketChanges,
  );
  async function result<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof TradingError)
        throw new ORPCError(
          error.code === "FORBIDDEN"
            ? "FORBIDDEN"
            : error.code === "NOT_FOUND"
              ? "NOT_FOUND"
              : "BAD_REQUEST",
          { message: error.message, data: { reason: error.code } },
        );
      throw error;
    }
  }
  return {
    businessCycle: {
      list: ctx.authed.businessCycle.list.handler(({ context }) =>
        result(() => service.list(context.actor)),
      ),
      get: ctx.authed.businessCycle.get.handler(({ context, input }) =>
        result(() => service.get(context.actor, input.cycleId)),
      ),
      createDemo: ctx.authed.businessCycle.createDemo.handler(async ({ context, input }) => {
        await requireIdentityConfirmation(ctx.deps.auth, context);
        return result(() => service.createDemo(context.actor, input.requestId));
      }),
      importEvidence: ctx.authed.businessCycle.importEvidence.handler(
        async ({ context, input }) => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return result(() => service.importEvidence(context.actor, input));
        },
      ),
      demoResults: ctx.authed.businessCycle.demoResults.handler(async ({ context, input }) => {
        await requireIdentityConfirmation(ctx.deps.auth, context);
        return result(() => service.demoResults(context.actor, input.cycleId, input.executionId));
      }),
      demoMetering: ctx.authed.businessCycle.demoMetering.handler(async ({ context, input }) => {
        await requireIdentityConfirmation(ctx.deps.auth, context);
        return result(() => service.demoMetering(context.actor, input));
      }),
      analyze: ctx.authed.businessCycle.analyze.handler(({ context, input }) =>
        result(() => service.analyze(context.actor, input)),
      ),
      settle: ctx.authed.businessCycle.settle.handler(({ context, input }) =>
        result(() => service.settle(context.actor, input.cycleId)),
      ),
      assign: ctx.authed.businessCycle.assign.handler(({ context, input }) =>
        result(() => service.assign(context.actor, input)),
      ),
      complete: ctx.authed.businessCycle.complete.handler(({ context, input }) =>
        result(() => service.complete(context.actor, input.ticketId, input.result)),
      ),
    },
  };
}

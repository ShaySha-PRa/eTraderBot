import { ORPCError } from "@orpc/server";
import { TradingError } from "@rakazo/core";
import { createWorkspaceAccessService } from "@rakazo/db";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import type { RouterContext } from "./context.js";

async function result<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TradingError)
      throw new ORPCError(
        error.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "FORBIDDEN"
            ? "FORBIDDEN"
            : "BAD_REQUEST",
        { message: error.message, data: { reason: error.code } },
      );
    throw error;
  }
}
export function workspaceAccessRoutes(ctx: RouterContext) {
  const service = createWorkspaceAccessService(ctx.deps.prisma);
  const api = ctx.authed.workspaceAccess;
  return {
    workspaceAccess: {
      catalog: api.catalog.handler(({ context }) => result(() => service.catalog(context.actor))),
      grants: api.grants.handler(({ context }) => result(() => service.grants(context.actor))),
      audit: api.audit.handler(({ context }) => result(() => service.audit(context.actor))),
      grant: api.grant.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.grant(context.actor, input);
        }),
      ),
      revoke: api.revoke.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.revoke(context.actor, input.id);
        }),
      ),
      received: api.received.handler(({ context, input }) =>
        result(() => service.received({ ...context.actor, botId: input.botId })),
      ),
      read: api.read.handler(({ context, input }) =>
        result(() => service.read({ ...context.actor, botId: input.botId }, input.grantId)),
      ),
    },
  };
}

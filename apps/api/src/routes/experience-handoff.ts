import { ORPCError } from "@orpc/server";
import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import { TradingError } from "@rakazo/core";
import { createExperienceHandoffService, ExperienceHandoffError } from "@rakazo/db";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import type { RouterContext } from "./context.js";

async function result<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExperienceHandoffError || error instanceof TradingError) {
      const reason = error instanceof ExperienceHandoffError ? error.reason : error.code;
      throw new ORPCError(
        reason === "FORBIDDEN"
          ? "FORBIDDEN"
          : reason === "NOT_FOUND"
            ? "NOT_FOUND"
            : ["CONFLICT", "SOURCE_CHANGED", "STALE_PREVIEW"].includes(reason)
              ? "CONFLICT"
              : "BAD_REQUEST",
        { message: error.message, data: { reason } },
      );
    }
    throw error;
  }
}
export function experienceHandoffRoutes(ctx: RouterContext) {
  const service = createExperienceHandoffService(
    ctx.deps.prisma,
    BUILTIN_AGENT_SKILLS.map((skill) => skill.name),
  );
  const api = ctx.authed.experienceHandoff;
  return {
    experienceHandoff: {
      catalog: api.catalog.handler(({ context, input }) =>
        result(() => service.catalog(context.actor, input)),
      ),
      create: api.create.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.create(context.actor, input);
        }),
      ),
      get: api.get.handler(({ context, input }) => result(() => service.get(context.actor, input))),
      packages: api.packages.handler(({ context, input }) =>
        result(() => service.packages(context.actor, input)),
      ),
      preview: api.preview.handler(({ context, input }) =>
        result(() => service.preview(context.actor, input)),
      ),
      confirm: api.confirm.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.confirm(context.actor, input);
        }),
      ),
      history: api.history.handler(({ context, input }) =>
        result(() => service.history(context.actor, input)),
      ),
      importDetail: api.importDetail.handler(({ context, input }) =>
        result(() => service.importDetail(context.actor, input)),
      ),
      revoke: api.revoke.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.revoke(context.actor, input);
        }),
      ),
      skills: api.skills.handler(({ context, input }) =>
        result(() => service.skills(context.actor, input)),
      ),
      updateSkill: api.updateSkill.handler(({ context, input }) =>
        result(async () => {
          await requireIdentityConfirmation(ctx.deps.auth, context);
          return service.updateSkill(context.actor, input);
        }),
      ),
    },
  };
}

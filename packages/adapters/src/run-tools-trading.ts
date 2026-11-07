import { BusinessCycleCommandSchema, WorkspaceReadCommandSchema } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import {
  businessOverview,
  createBusinessCycleService,
  createWorkspaceAccessService,
} from "@rakazo/db";
import { uncertainEffectResult } from "./approval-effect.js";
import type { ToolHandlers } from "./run-tool-gate.js";

export const tradingTools = {
  async business_cycle(ctx, call) {
    const parsed = BusinessCycleCommandSchema.safeParse(call.args);
    // This check precedes every service call, so no business write could have happened.
    if (!parsed.success) return { error: "Business cycle request failed", code: "INVALID_INPUT" };
    const input = parsed.data;
    let value: unknown;
    try {
      const who = { spaceId: ctx.run.spaceId, userId: ctx.run.userId, botId: ctx.bot.id };
      const service = createBusinessCycleService(
        ctx.deps.prisma,
        undefined,
        ctx.deps.onTicketChange,
      );
      value =
        input.operation === "list"
          ? await service.list(who)
          : input.operation === "read"
            ? await service.get(who, input.cycleId)
            : input.operation === "assign"
              ? await service.assign(who, {
                  cycleId: input.cycleId,
                  requestId: input.requestId,
                  kind: input.kind,
                  dependsOn: input.dependsOn,
                })
              : input.operation === "analyze"
                ? await service.analyze(who, {
                    cycleId: input.cycleId,
                    deskId: input.deskId,
                    margin: input.margin,
                  })
                : input.operation === "settle"
                  ? await service.settle(who, input.cycleId)
                  : await service.complete(
                      who,
                      input.ticketId,
                      input.result,
                      input.expectedResultEvidenceId,
                    );
    } catch (error) {
      if (error instanceof TradingError) return { error: error.message, code: error.code };
      // A write lost to infrastructure or post-commit readback validation may have committed.
      // In particular, a service-side ZodError is not proof that nothing was written.
      return input.operation === "list" || input.operation === "read"
        ? { error: "Business cycle request failed" }
        : uncertainEffectResult("business_cycle", call.args);
    }
    return call.finish(value);
  },
  async business_overview(ctx, call) {
    try {
      return call.finish(
        await businessOverview(ctx.deps.prisma, {
          spaceId: ctx.run.spaceId,
          userId: ctx.run.userId,
          botId: ctx.bot.id,
        }),
      );
    } catch (error) {
      return {
        error: error instanceof TradingError ? error.message : "Business overview unavailable",
      };
    }
  },
  async read_trading_material(ctx, call) {
    const input = WorkspaceReadCommandSchema.parse(call.args);
    const service = createWorkspaceAccessService(ctx.deps.prisma);
    const identity = { spaceId: ctx.run.spaceId, userId: ctx.run.userId, botId: ctx.bot.id };
    try {
      return call.finish(
        input.operation === "list"
          ? await service.received(identity)
          : await service.read(identity, input.grantId),
      );
    } catch (error) {
      return { error: error instanceof TradingError ? error.message : "Material read failed" };
    }
  },
  async trading(ctx, call) {
    if (!ctx.deps.trading) return { error: "Trading is unavailable" };
    try {
      const result = await ctx.deps.trading.call(
        { userId: ctx.run.userId, spaceId: ctx.run.spaceId, botId: ctx.bot.id, runId: ctx.run.id },
        call.args,
      );
      return call.finish(result);
    } catch (error) {
      if (error instanceof TradingError) return { error: error.message, code: error.code };
      return { error: "Trading request failed; check the trading page before retrying" };
    }
  },
} satisfies ToolHandlers;

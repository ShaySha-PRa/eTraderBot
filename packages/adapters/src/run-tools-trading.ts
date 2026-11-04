import { WorkspaceReadCommandSchema } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import { businessOverview, createWorkspaceAccessService } from "@rakazo/db";
import type { ToolHandlers } from "./run-tool-gate.js";

export const tradingTools = {
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

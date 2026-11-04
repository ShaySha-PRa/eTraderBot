import { TradingError } from "@rakazo/core";
import type { ToolHandlers } from "./run-tool-gate.js";

export const tradingTools = {
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

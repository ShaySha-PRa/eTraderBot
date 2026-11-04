import { z } from "zod";

export const TradingBotRoleSchema = z.enum(["mid_long_term", "spot", "risk", "review"]);
export type TradingBotRole = z.infer<typeof TradingBotRoleSchema>;

export function tradingBotSupportsStage(role: TradingBotRole, stage: string) {
  return (
    role === "risk" ||
    role === "review" ||
    (role === "mid_long_term" ? stage === "mid_long_term" : stage !== "mid_long_term")
  );
}

/** Supplied by the composition root; identity comes from the persisted run, never tool args. */
export type TradingBotIdentity = { userId: string; spaceId: string; botId: string; runId?: string };
export interface TradingBotGateway {
  available(identity: TradingBotIdentity): Promise<boolean>;
  /** Learning runs receive only scoped trading evidence, with no shared chat or memory context. */
  isLearningRun?(identity: TradingBotIdentity): Promise<boolean>;
  call(identity: TradingBotIdentity, input: unknown): Promise<unknown>;
}

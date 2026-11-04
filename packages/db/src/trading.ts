import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Actor, TradingAnalysis } from "@rakazo/contracts";
import { TradingAnalysisSchema, TradingSimulationInputSchema } from "@rakazo/contracts";
import {
  createTradingSimulationSnapshot,
  runTradingBaseline,
  tradingAssert,
  tradingDecimal,
  tradingDecimalString,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { tradingAlgorithmIdentity } from "./trading-engine.js";

function analysisDto(row: {
  id: string;
  createdAt: Date;
  snapshot: unknown;
  decision: unknown;
  parameters: unknown;
}): TradingAnalysis {
  return TradingAnalysisSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

/** Authenticated application entry point; synthetic analyses never submit trades. */
export function createTradingAnalysisService(
  prisma: PrismaClient,
  clock: () => Date = () => new Date(),
) {
  const select = {
    id: true,
    createdAt: true,
    snapshot: true,
    decision: true,
    parameters: true,
  } as const;
  async function get(actor: Actor, id: string) {
    const row = await prisma.tradingAnalysis.findFirst({
      where: { id, spaceId: actor.spaceId, userId: actor.userId },
      select,
    });
    tradingAssert(row, "NOT_FOUND", "Trading analysis not found");
    return analysisDto(row);
  }
  return {
    async simulate(actor: Actor, raw: unknown) {
      const input = TradingSimulationInputSchema.parse(raw);
      const parameters = { margin: tradingDecimalString(tradingDecimal(input.parameters.margin)) };
      const now = clock();
      const snapshot = createTradingSimulationSnapshot(input.scope, now);
      snapshot.snapshotId = randomUUID();
      const decision = runTradingBaseline(
        snapshot,
        tradingAlgorithmIdentity(input.scope.subjectKind, parameters),
        parameters,
        now,
      );
      const row = await prisma.tradingAnalysis.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          snapshot,
          decision: { ...decision },
          parameters,
          createdAt: now,
        },
        select,
      });
      return analysisDto(row);
    },
    get,
    async replay(actor: Actor, id: string) {
      const analysis = await get(actor, id);
      const algorithmVersionId = tradingAlgorithmIdentity(
        analysis.snapshot.scope.subjectKind,
        analysis.parameters,
      );
      tradingAssert(
        algorithmVersionId === analysis.decision.algorithmVersionId,
        "ENGINE_CHANGED",
        "The original engine is unavailable; recompute to create a new version",
      );
      // Historical evidence is evaluated at its original observation time. A replay never
      // renews source validity or grants permission to submit the historical decision.
      const decision = runTradingBaseline(
        analysis.snapshot,
        algorithmVersionId,
        analysis.parameters,
        new Date(analysis.createdAt),
      );
      return {
        analysisId: id,
        matchesRecordedDecision: isDeepStrictEqual(decision, analysis.decision),
        decision,
      };
    },
    async history(actor: Actor, limit: number) {
      tradingAssert(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        "INVALID_INPUT",
        "Invalid history limit",
      );
      const rows = await prisma.tradingAnalysis.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      });
      return rows.map(analysisDto);
    },
  };
}

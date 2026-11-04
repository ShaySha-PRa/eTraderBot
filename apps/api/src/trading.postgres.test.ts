import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, TradingScope } from "@rakazo/contracts";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("trading analysis API (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let actor: Actor;
  let peer: Actor;
  let elsewhere: Actor;
  let storedId: string;
  const suffix = randomUUID();
  const orgId = `trading-org-${suffix}`;
  const scope = (
    kind: TradingScope["subjectKind"],
  ): TradingScope & { environment: "simulation" } => ({
    subjectId: "synthetic-subject",
    subjectKind: kind,
    accountId: "synthetic-account",
    assetId: "synthetic-asset",
    region: "CN-SD",
    marketId: "synthetic",
    productId: "energy",
    stage: "day_ahead",
    environment: "simulation",
  });
  const client = (who: Actor | null = actor) =>
    createRouterClient(createRouter({ prisma: db.prisma, env: {} } as unknown as RouterDeps), {
      context: { actor: who },
    });

  beforeAll(() =>
    runAsSystem("trading analysis test fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      const ownerId = `trading-owner-${suffix}`,
        peerId = `trading-peer-${suffix}`;
      await db.prisma.user.createMany({
        data: [
          { id: ownerId, name: "Trading owner", email: `${ownerId}@example.test` },
          { id: peerId, name: "Trading peer", email: `${peerId}@example.test` },
        ],
      });
      await db.prisma.organization.create({
        data: { id: orgId, name: "Trading fixture", slug: orgId, createdAt: new Date() },
      });
      const space = await db.prisma.space.create({
        data: {
          id: `trading-space-${suffix}`,
          name: "Trading",
          organizationId: orgId,
          createdByUserId: ownerId,
        },
      });
      const otherSpace = await db.prisma.space.create({
        data: {
          id: `trading-other-${suffix}`,
          name: "Other",
          organizationId: orgId,
          createdByUserId: ownerId,
        },
      });
      actor = {
        userId: ownerId,
        spaceId: space.id,
        email: `${ownerId}@example.test`,
        isDeploymentOwner: false,
      };
      peer = { ...actor, userId: peerId, email: `${peerId}@example.test` };
      elsewhere = { ...actor, spaceId: otherSpace.id };
    }),
  );
  afterAll(() =>
    runAsSystem("trading analysis test cleanup", async () => {
      if (!db) return;
      await db.prisma.organization.deleteMany({ where: { id: orgId } });
      await db.prisma.user.deleteMany({
        where: {
          id: {
            in: [actor?.userId, peer?.userId].filter((value): value is string => Boolean(value)),
          },
        },
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it.each(["retailer", "generator", "storage"] as const)(
    "persists a real %s calculation and its input evidence",
    async (kind) => {
      const result = await client().trading.simulate({
        scope: scope(kind),
        parameters: { margin: "0" },
      });
      expect(result.snapshot.input.kind).toBe(kind);
      expect(result.snapshot.source.kind).toBe("synthetic");
      expect(result.decision.lines.length).toBeGreaterThan(0);
      expect(result.decision.snapshotId).toBe(result.snapshot.snapshotId);
      expect(result.decision.scope).toEqual(scope(kind));
      expect(await client().trading.get({ id: result.id })).toEqual(result);
      expect(await client().trading.replay({ id: result.id })).toEqual({
        analysisId: result.id,
        matchesRecordedDecision: true,
        decision: result.decision,
      });
      storedId = result.id;
    },
  );
  it("lists only the caller's persisted analyses with a bounded history", async () => {
    expect(await client().trading.history({ limit: 2 })).toHaveLength(2);
    expect(await client(peer).trading.history({ limit: 20 })).toEqual([]);
    expect(await client(elsewhere).trading.history({ limit: 20 })).toEqual([]);
  });
  it("denies other users and spaces at the API boundary", async () => {
    await expect(client(peer).trading.get({ id: storedId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client(elsewhere).trading.get({ id: storedId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client(peer).trading.replay({ id: storedId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("enforces isolation in the database even for queries without user filters", async () => {
    const mine = await runAsTenant(actor, () => db.prisma.tradingAnalysis.findMany());
    const theirs = await runAsTenant(peer, () => db.prisma.tradingAnalysis.findMany());
    const others = await runAsTenant(elsewhere, () => db.prisma.tradingAnalysis.findMany());
    expect(mine).toHaveLength(3);
    expect(theirs).toEqual([]);
    expect(others).toEqual([]);
  });
  it("requires authentication", async () => {
    await expect(client(null).trading.history({ limit: 20 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("rejects live analysis through the synthetic endpoint", async () => {
    const invalid = JSON.parse(
      JSON.stringify({ scope: { ...scope("retailer"), environment: "live" } }),
    );
    await expect(client().trading.simulate(invalid)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("binds the algorithm identifier to normalized parameters", async () => {
    const a = await client().trading.simulate({
      scope: scope("generator"),
      parameters: { margin: "1.0" },
    });
    const b = await client().trading.simulate({
      scope: scope("generator"),
      parameters: { margin: "1" },
    });
    const c = await client().trading.simulate({
      scope: scope("generator"),
      parameters: { margin: "2" },
    });
    expect(a.decision.algorithmVersionId).toBe(b.decision.algorithmVersionId);
    expect(a.decision.algorithmVersionId).not.toBe(c.decision.algorithmVersionId);
    expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId);
  });
  it("does not mutate persisted evidence when a client edits its response", async () => {
    const result = await client().trading.get({ id: storedId });
    result.decision.lines.length = 0;
    expect((await client().trading.get({ id: storedId })).decision.lines.length).toBeGreaterThan(0);
  });
  it("refuses to label the current engine as an unavailable historical version", async () => {
    const analysis = await client().trading.simulate({ scope: scope("retailer") });
    await runAsSystem("historical engine compatibility fixture", () =>
      db.prisma.tradingAnalysis.update({
        where: { id: analysis.id },
        data: { decision: { ...analysis.decision, algorithmVersionId: "unavailable-old-engine" } },
      }),
    );
    await expect(client().trading.replay({ id: analysis.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "ENGINE_CHANGED" },
    });
    expect((await client().trading.get({ id: analysis.id })).decision.algorithmVersionId).toBe(
      "unavailable-old-engine",
    );
  });
});

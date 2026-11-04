import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, RpcInput, TradingScope } from "@rakazo/contracts";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("trading approval and execution API (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const suffix = randomUUID();
  const orgId = `control-org-${suffix}`;
  let spaceId = `control-space-${suffix}`;
  const actor = (role: string): Actor => ({
    userId: `${role}-${suffix}`,
    spaceId,
    email: `${role}-${suffix}@example.test`,
    isDeploymentOwner: false,
  });
  const owner = actor("owner"),
    algorithm = actor("algorithm"),
    trader = actor("trader"),
    stranger = actor("stranger");
  const epoch = new Date("2026-11-03T00:00:00.000Z");
  let now = new Date(epoch);
  const client = (who: Actor | null = owner, confirmed = true) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        tradingClock: () => new Date(now),
        auth: { hasRecentIdentityConfirmation: async () => confirmed },
      } as unknown as RouterDeps),
      { context: { actor: who, ...(confirmed ? { sessionId: "confirmed-test-session" } : {}) } },
    );
  const scope = (
    kind: TradingScope["subjectKind"] = "retailer",
  ): TradingScope & { environment: "simulation" } => ({
    subjectId: `synthetic-${kind}`,
    subjectKind: kind,
    accountId: "synthetic-account",
    assetId: "synthetic-asset",
    region: "CN-SD",
    marketId: "synthetic",
    productId: "energy",
    stage: "day_ahead",
    environment: "simulation",
  });
  const expiresAt = () => new Date(now.getTime() + 900_000).toISOString();
  async function setup(kind: TradingScope["subjectKind"] = "retailer", samePerson = false) {
    now = new Date(epoch);
    const desk = await client().trading.createDesk({
      scope: scope(kind),
      algorithmApproverUserId: samePerson ? owner.userId : algorithm.userId,
      tradeApproverUserId: samePerson ? owner.userId : trader.userId,
    });
    const analysis = await client().trading.simulate({ scope: desk.scope });
    const intent = await client().trading.prepareIntent({
      deskId: desk.id,
      analysisId: analysis.id,
      expiresAt: expiresAt(),
    });
    const version = (await client().trading.desk({ deskId: desk.id })).versions[0]!;
    const algoClient = client(samePerson ? owner : algorithm),
      tradeClient = client(samePerson ? owner : trader);
    const enable = () =>
      algoClient.trading.approveAlgorithm({
        deskId: desk.id,
        versionId: version.id,
        expectedArtifactHash: version.artifactHash,
      });
    const approve = () =>
      tradeClient.trading.approveIntent({
        deskId: desk.id,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
      });
    const request = (
      key = randomUUID(),
      grantId?: string,
    ): RpcInput<"trading/executeSimulation"> => ({
      deskId: desk.id,
      intentId: intent.id,
      clientRequestId: key,
      expectedIntentHash: intent.intent.intentHash,
      ...(grantId ? { grantId } : {}),
    });
    const grant = (perTradeLimitCny = "5000", cumulativeLimitCny = "10000") =>
      tradeClient.trading.createGrant({
        deskId: desk.id,
        versionId: version.id,
        perTradeLimitCny,
        cumulativeLimitCny,
        expiresAt: expiresAt(),
      });
    return {
      desk,
      analysis,
      intent,
      version,
      enable,
      approve,
      request,
      grant,
      algoClient,
      tradeClient,
    };
  }
  const reason = (code: string) => ({ data: { reason: code } });
  beforeAll(() =>
    runAsSystem("trading control test fixtures", async () => {
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.createMany({
        data: [owner, algorithm, trader, stranger].map((person) => ({
          id: person.userId,
          name: "Synthetic user",
          email: person.email,
        })),
      });
      await db.prisma.organization.create({
        data: { id: orgId, name: "Trading test", slug: orgId, createdAt: epoch },
      });
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: spaceId,
          organizationId: orgId,
          name: "Trading test",
          createdByUserId: owner.userId,
        },
      });
      for (const person of [owner, algorithm, trader, stranger]) {
        await db.prisma.member.create({
          data: {
            id: `member-${person.userId}`,
            userId: person.userId,
            organizationId: orgId,
            role: "member",
            createdAt: epoch,
          },
        });
        await db.prisma.spaceMember.create({
          data: {
            id: `sm-${person.userId}`,
            spaceId,
            organizationId: orgId,
            userId: person.userId,
            createdAt: epoch,
          },
        });
      }
    }),
  );
  beforeEach(() =>
    runAsSystem("isolated approval business fixture", async () => {
      spaceId = randomUUID();
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: spaceId,
          organizationId: orgId,
          name: "Synthetic business",
          createdByUserId: owner.userId,
        },
      });
      for (const person of [owner, algorithm, trader, stranger]) {
        person.spaceId = spaceId;
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId,
            organizationId: orgId,
            userId: person.userId,
            role: person === owner ? "owner" : "member",
            createdAt: epoch,
          },
        });
      }
    }),
  );
  afterAll(() =>
    runAsSystem("trading control test cleanup", async () => {
      if (!db) return;
      await db.prisma.organization.deleteMany({ where: { id: orgId } });
      await db.prisma.user.deleteMany({
        where: { id: { in: [owner, algorithm, trader, stranger].map((person) => person.userId) } },
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it.each(["retailer", "generator", "storage"] as const)(
    "runs %s through two independent approvals and a synthetic receipt",
    async (kind) => {
      const flow = await setup(kind);
      await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
        reason("ALGORITHM_NOT_APPROVED"),
      );
      await flow.enable();
      await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
        reason("TRADE_NOT_APPROVED"),
      );
      await flow.approve();
      const result = await client().trading.executeSimulation(flow.request());
      expect(result.receipt).toMatchObject({
        status: "filled",
        source: { kind: "synthetic" },
        intentHash: flow.intent.intent.intentHash,
      });
      expect(result.receipt.fills).toHaveLength(flow.intent.intent.lines.length);
      expect(
        await client().trading.executionByRequest({
          deskId: flow.desk.id,
          clientRequestId: result.clientRequestId,
        }),
      ).toEqual(result);
      const state = await flow.tradeClient.trading.desk({ deskId: flow.desk.id });
      expect(state.audit.map((event) => event.kind)).toEqual(
        expect.arrayContaining(["algorithm.approved", "intent.approved", "execution.simulated"]),
      );
      expect(state.versions[0]!.approvedByUserId).toBe(algorithm.userId);
      expect(state.intents[0]!.approvedByUserId).toBe(trader.userId);
    },
  );
  it("allows one person to hold both explicitly assigned roles", async () => {
    const flow = await setup("retailer", true);
    await flow.enable();
    await flow.approve();
    expect((await client().trading.executeSimulation(flow.request())).receipt.status).toBe(
      "filled",
    );
  });
  it("does not treat single-trade approval as algorithm enablement", async () => {
    const flow = await setup();
    await flow.approve();
    await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
      reason("ALGORITHM_NOT_APPROVED"),
    );
    await flow.enable();
    expect((await client().trading.executeSimulation(flow.request())).receipt.status).toBe(
      "filled",
    );
  });
  it("rejects analysis from another account or business stage", async () => {
    const flow = await setup();
    for (const patch of [
      { accountId: "other-account" },
      { assetId: "other-asset" },
      { subjectId: "other-subject" },
      { marketId: "other-market" },
      { stage: "intraday" as const },
    ]) {
      const other = await client().trading.simulate({ scope: { ...flow.desk.scope, ...patch } });
      await expect(
        client().trading.prepareIntent({
          deskId: flow.desk.id,
          analysisId: other.id,
          expiresAt: expiresAt(),
        }),
      ).rejects.toMatchObject(reason("SCOPE_MISMATCH"));
    }
  });
  it("binds algorithm approval to its artifact hash and preserves the archived artifact", async () => {
    const flow = await setup();
    await expect(
      flow.algoClient.trading.approveAlgorithm({
        deskId: flow.desk.id,
        versionId: flow.version.id,
        expectedArtifactHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject(reason("ENGINE_CHANGED"));
    await expect(
      runAsSystem("attempt to mutate archived algorithm evidence", () =>
        db.prisma.tradingVersion.update({
          where: { id: flow.version.id },
          data: { artifact: "different-engine" },
        }),
      ),
    ).rejects.toThrow();
    const version = (await client().trading.desk({ deskId: flow.desk.id })).versions[0]!;
    expect(version.artifact).toBe(flow.version.artifact);
    expect(version.status).toBe("pending");
    expect((await client().trading.desk({ deskId: flow.desk.id })).executions).toHaveLength(0);
  });
  it("rejects a genuine no-trade decision as an executable intent", async () => {
    const flow = await setup("generator");
    const analysis = await client().trading.simulate({
      scope: flow.desk.scope,
      parameters: { margin: "1000" },
    });
    expect(analysis.decision.lines).toEqual([]);
    await expect(
      client().trading.prepareIntent({
        deskId: flow.desk.id,
        analysisId: analysis.id,
        expiresAt: expiresAt(),
      }),
    ).rejects.toMatchObject(reason("RISK_REJECTED"));
  });
  it("serializes revocation with concurrent submission and stops all later submissions", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant();
    const request = flow.request(randomUUID(), grant.id);
    const [submission] = await Promise.allSettled([
      client().trading.executeSimulation(request),
      flow.tradeClient.trading.revokeGrant({ deskId: flow.desk.id, grantId: grant.id }),
    ]);
    if (submission.status === "rejected")
      expect(submission.reason).toMatchObject(reason("GRANT_INACTIVE"));
    const state = await client().trading.desk({ deskId: flow.desk.id });
    expect(state.grants[0]!.revokedAt).not.toBeNull();
    expect(state.grants[0]!.usedCny).toBe(submission.status === "fulfilled" ? "5000" : "0");
    const next = await client().trading.prepareIntent({
      deskId: flow.desk.id,
      analysisId: flow.analysis.id,
      expiresAt: expiresAt(),
    });
    await expect(
      client().trading.executeSimulation({
        ...request,
        clientRequestId: randomUUID(),
        intentId: next.id,
        expectedIntentHash: next.intent.intentHash,
      }),
    ).rejects.toMatchObject(reason("GRANT_INACTIVE"));
  });
  it("rejects the other approval role and Space membership alone", async () => {
    const flow = await setup();
    await expect(
      client(trader).trading.approveAlgorithm({
        deskId: flow.desk.id,
        versionId: flow.version.id,
        expectedArtifactHash: flow.version.artifactHash,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client(algorithm).trading.approveIntent({
        deskId: flow.desk.id,
        intentId: flow.intent.id,
        expectedIntentHash: flow.intent.intent.intentHash,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client(stranger).trading.desk({ deskId: flow.desk.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client({ ...owner, spaceId: "other-space" }).trading.desk({ deskId: flow.desk.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("requires a confirmed human session for approval and role assignment", async () => {
    const flow = await setup();
    await expect(
      client(algorithm, false).trading.approveAlgorithm({
        deskId: flow.desk.id,
        versionId: flow.version.id,
        expectedArtifactHash: flow.version.artifactHash,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFIRMATION_REQUIRED" });
    await expect(
      client(owner, false).trading.createDesk({
        scope: scope(),
        algorithmApproverUserId: owner.userId,
        tradeApproverUserId: owner.userId,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFIRMATION_REQUIRED" });
    await expect(client(null).trading.desks({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("does not allow roles to be assigned to users outside this Space", async () => {
    await expect(
      client().trading.createDesk({
        scope: scope(),
        algorithmApproverUserId: "missing-member",
        tradeApproverUserId: owner.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("binds approval and submission to exact immutable content", async () => {
    const flow = await setup();
    await flow.enable();
    await expect(
      flow.tradeClient.trading.approveIntent({
        deskId: flow.desk.id,
        intentId: flow.intent.id,
        expectedIntentHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject(reason("INTENT_CHANGED"));
    await flow.approve();
    await expect(
      client().trading.executeSimulation({ ...flow.request(), expectedIntentHash: "a".repeat(64) }),
    ).rejects.toMatchObject(reason("INTENT_CHANGED"));
    expect((await client().trading.desk({ deskId: flow.desk.id })).executions).toEqual([]);
  });
  it("atomically deduplicates parallel retries and refuses request-key reuse", async () => {
    const flow = await setup();
    await flow.enable();
    await flow.approve();
    const request = flow.request();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => client().trading.executeSimulation(request)),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await client().trading.desk({ deskId: flow.desk.id })).executions).toHaveLength(1);
    await expect(
      client().trading.executeSimulation({ ...request, expectedIntentHash: "b".repeat(64) }),
    ).rejects.toMatchObject(reason("IDEMPOTENCY_CONFLICT"));
    await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
      reason("ALREADY_SUBMITTED"),
    );
  });
  it("uses grants without inheriting a single-intent approval and preserves historical queries after revocation", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant();
    const request = flow.request(randomUUID(), grant.id);
    const execution = await client().trading.executeSimulation(request);
    await flow.tradeClient.trading.revokeGrant({ deskId: flow.desk.id, grantId: grant.id });
    expect(await client().trading.executeSimulation(request)).toEqual(execution);
    expect(
      await client().trading.executionByRequest({
        deskId: flow.desk.id,
        clientRequestId: request.clientRequestId,
      }),
    ).toEqual(execution);
    const next = await client().trading.prepareIntent({
      deskId: flow.desk.id,
      analysisId: flow.analysis.id,
      expiresAt: expiresAt(),
    });
    await expect(
      client().trading.executeSimulation({
        ...request,
        clientRequestId: randomUUID(),
        intentId: next.id,
        expectedIntentHash: next.intent.intentHash,
      }),
    ).rejects.toMatchObject(reason("GRANT_INACTIVE"));
  });
  it("prevents parallel requests spending the same remaining cumulative allowance", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant("5000", "5000");
    const another = await client().trading.prepareIntent({
      deskId: flow.desk.id,
      analysisId: flow.analysis.id,
      expiresAt: expiresAt(),
    });
    const results = await Promise.allSettled([
      client().trading.executeSimulation(flow.request(randomUUID(), grant.id)),
      client().trading.executeSimulation({
        ...flow.request(randomUUID(), grant.id),
        intentId: another.id,
        expectedIntentHash: another.intent.intentHash,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject(
      reason("CUMULATIVE_LIMIT"),
    );
    const state = await client().trading.desk({ deskId: flow.desk.id });
    expect(state.grants[0]!.usedCny).toBe("5000");
    expect(state.executions).toHaveLength(1);
  });
  it("rejects single-trade overages without consuming allowance", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant("4999", "10000");
    await expect(
      client().trading.executeSimulation(flow.request(randomUUID(), grant.id)),
    ).rejects.toMatchObject(reason("PER_TRADE_LIMIT"));
    expect((await client().trading.desk({ deskId: flow.desk.id })).grants[0]!.usedCny).toBe("0");
  });
  it("does not transfer a grant to changed algorithm parameters", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant();
    const analysis = await client().trading.simulate({
      scope: flow.desk.scope,
      parameters: { margin: "1" },
    });
    const next = await client().trading.prepareIntent({
      deskId: flow.desk.id,
      analysisId: analysis.id,
      expiresAt: expiresAt(),
    });
    const version = (await client().trading.desk({ deskId: flow.desk.id })).versions.find(
      (item) => item.id === next.versionId,
    )!;
    await flow.algoClient.trading.approveAlgorithm({
      deskId: flow.desk.id,
      versionId: version.id,
      expectedArtifactHash: version.artifactHash,
    });
    await expect(
      client().trading.executeSimulation({
        ...flow.request(randomUUID(), grant.id),
        intentId: next.id,
        expectedIntentHash: next.intent.intentHash,
      }),
    ).rejects.toMatchObject(reason("GRANT_MISMATCH"));
  });
  it("keeps large grant limits as exact decimal strings", async () => {
    const flow = await setup();
    await flow.enable();
    const limit = "999999999999999999999999999999";
    const grant = await flow.grant(limit, limit);
    expect(grant.perTradeLimitCny).toBe(limit);
    expect(grant.cumulativeLimitCny).toBe(limit);
    await client().trading.executeSimulation(flow.request(randomUUID(), grant.id));
    const saved = (await client().trading.desk({ deskId: flow.desk.id })).grants[0]!;
    expect(saved.cumulativeLimitCny).toBe(limit);
    expect(saved.usedCny).toBe("5000");
  });
  it("prevents database updates from changing reviewed content or resetting consumed limits", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant();
    await client().trading.executeSimulation(flow.request(randomUUID(), grant.id));
    await expect(
      runAsSystem("attempt reviewed intent mutation", () =>
        db.prisma.tradingIntent.update({
          where: { id: flow.intent.id },
          data: { grossNotionalCny: "1" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runAsSystem("attempt consumed quota reset", () =>
        db.prisma.tradingGrant.update({ where: { id: grant.id }, data: { usedCny: "0" } }),
      ),
    ).rejects.toThrow();
    await expect(
      runAsSystem("attempt scope mutation", () =>
        db.prisma.tradingDesk.update({
          where: { id: flow.desk.id },
          data: { scope: { ...flow.desk.scope, accountId: "different" } },
        }),
      ),
    ).rejects.toThrow();
    const state = await client().trading.desk({ deskId: flow.desk.id });
    expect(state.grants[0]!.usedCny).toBe("5000");
    expect(state.intents[0]!.intent).toEqual(flow.intent.intent);
  });
  it("rejects expired grants while the intent and data are still current", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.tradeClient.trading.createGrant({
      deskId: flow.desk.id,
      versionId: flow.version.id,
      perTradeLimitCny: "5000",
      cumulativeLimitCny: "5000",
      expiresAt: new Date(now.getTime() + 1000).toISOString(),
    });
    now = new Date(now.getTime() + 2000);
    await expect(
      client().trading.executeSimulation(flow.request(randomUUID(), grant.id)),
    ).rejects.toMatchObject(reason("GRANT_INACTIVE"));
  });
  it("rejects expired intents and retired algorithms", async () => {
    const flow = await setup();
    await flow.enable();
    await flow.approve();
    now = new Date(now.getTime() + 900_001);
    await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
      reason("EXPIRED"),
    );
    now = new Date(epoch);
    await flow.algoClient.trading.retireAlgorithm({
      deskId: flow.desk.id,
      versionId: flow.version.id,
    });
    await expect(client().trading.executeSimulation(flow.request())).rejects.toMatchObject(
      reason("ALGORITHM_NOT_APPROVED"),
    );
  });
  it("enforces business-scope row security without application filters", async () => {
    const flow = await setup();
    const visible = await runAsTenant(trader, () =>
      db.prisma.tradingIntent.findMany({ where: { id: flow.intent.id } }),
    );
    const invisible = await runAsTenant(stranger, () => db.prisma.tradingIntent.findMany());
    expect(visible).toHaveLength(1);
    expect(invisible).toEqual([]);
    await expect(
      client(stranger).trading.executionByRequest({
        deskId: flow.desk.id,
        clientRequestId: "unknown",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects a simulation desk being used as a live scope", async () => {
    const input = JSON.parse(
      JSON.stringify({
        scope: { ...scope(), environment: "live" },
        algorithmApproverUserId: owner.userId,
        tradeApproverUserId: owner.userId,
      }),
    );
    await expect(client().trading.createDesk(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it.each(["retailer", "generator", "storage"] as const)(
    "persists partial fills and reconciles %s once across concurrent requests",
    async (kind) => {
      const flow = await setup(kind);
      await flow.enable();
      const grant = await flow.grant(flow.intent.grossNotionalCny, flow.intent.grossNotionalCny);
      await client().trading.configureSimulation({
        deskId: flow.desk.id,
        scenario: "partial_fill",
      });
      const request = flow.request(randomUUID(), grant.id);
      const result = await client().trading.executeSimulation(request);
      expect(result.receipt.status).toBe("partially_filled");
      let state = await client().trading.desk({ deskId: flow.desk.id });
      expect(Number(state.grants[0]!.usedCny) + Number(state.grants[0]!.reservedCny)).toBe(
        Number(flow.intent.grossNotionalCny),
      );
      expect(Number(state.grants[0]!.reservedCny)).toBeGreaterThan(0);
      await flow.tradeClient.trading.revokeGrant({ deskId: flow.desk.id, grantId: grant.id });
      await flow.algoClient.trading.retireAlgorithm({
        deskId: flow.desk.id,
        versionId: flow.version.id,
      });
      now = new Date(epoch.getTime() + 86_400_000);
      const reconcile = {
        deskId: flow.desk.id,
        executionId: result.id,
        expectedSequence: result.receipt.sequence,
      };
      const [one, two] = await Promise.all([
        client().trading.reconcileExecution(reconcile),
        client().trading.reconcileExecution(reconcile),
      ]);
      expect(one).toEqual(two);
      expect(one.receipt.status).toBe("filled");
      expect(one.receipts).toHaveLength(2);
      expect(one.receipts[0]).toEqual(result.receipt);
      expect(
        await runAsTenant(stranger, () =>
          db.prisma.tradingExecutionEvent.findMany({ where: { executionId: result.id } }),
        ),
      ).toEqual([]);
      expect(
        await runAsTenant(stranger, () =>
          db.prisma.tradingSimulationPolicy.findUnique({ where: { deskId: flow.desk.id } }),
        ),
      ).toBeNull();
      expect((await client().trading.executeSimulation(request)).receipt).toEqual(one.receipt);
      state = await client().trading.desk({ deskId: flow.desk.id });
      expect(state.grants[0]).toMatchObject({
        usedCny: flow.intent.grossNotionalCny,
        reservedCny: "0",
      });
      await expect(
        runAsSystem("cannot overwrite receipt history", () =>
          db.prisma.tradingExecutionEvent.updateMany({
            where: { executionId: result.id },
            data: { receipt: {} },
          }),
        ),
      ).rejects.toThrow();
    },
  );

  it("holds uncertain reservations, refuses excess capacity, and releases only unfilled cancellation balance", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant("5000", "5000");
    await client().trading.configureSimulation({ deskId: flow.desk.id, scenario: "timeout" });
    const request = flow.request(randomUUID(), grant.id);
    const execution = await client().trading.executeSimulation(request);
    expect(execution.receipt.status).toBe("unknown");
    const next = await client().trading.prepareIntent({
      deskId: flow.desk.id,
      analysisId: flow.analysis.id,
      expiresAt: expiresAt(),
    });
    const nextRequest = {
      ...request,
      intentId: next.id,
      expectedIntentHash: next.intent.intentHash,
      clientRequestId: randomUUID(),
    };
    await expect(client().trading.executeSimulation(nextRequest)).rejects.toMatchObject(
      reason("CUMULATIVE_LIMIT"),
    );
    const partial = await client().trading.reconcileExecution({
      deskId: flow.desk.id,
      executionId: execution.id,
      expectedSequence: 1,
    });
    expect(partial.receipt.status).toBe("partially_filled");
    const cancel = {
      deskId: flow.desk.id,
      executionId: execution.id,
      clientRequestId: randomUUID(),
    };
    await expect(client().trading.cancelSimulation(cancel)).rejects.toMatchObject(
      reason("FORBIDDEN"),
    );
    await expect(client(trader, false).trading.cancelSimulation(cancel)).rejects.toThrow();
    const [first, duplicate] = await Promise.all([
      flow.tradeClient.trading.cancelSimulation(cancel),
      flow.tradeClient.trading.cancelSimulation(cancel),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.receipt).toMatchObject({ status: "cancelled", fills: partial.receipt.fills });
    expect(first.receipts).toHaveLength(3);
    expect((await client().trading.desk({ deskId: flow.desk.id })).grants[0]).toMatchObject({
      usedCny: "2500",
      reservedCny: "0",
    });
    const query = await client().trading.executionByRequest({
      deskId: flow.desk.id,
      clientRequestId: request.clientRequestId,
    });
    expect(query).toEqual(first);
    await expect(
      client(stranger).trading.reconcileExecution({
        deskId: flow.desk.id,
        executionId: execution.id,
        expectedSequence: 3,
      }),
    ).rejects.toMatchObject(reason("NOT_FOUND"));
  });

  it("retains reservations through cancellation timeout and records confirmation separately", async () => {
    const flow = await setup();
    await flow.enable();
    const grant = await flow.grant();
    await client().trading.configureSimulation({
      deskId: flow.desk.id,
      scenario: "cancel_timeout",
    });
    const execution = await client().trading.executeSimulation(
      flow.request(randomUUID(), grant.id),
    );
    // Changing policy never changes an existing order's venue scenario.
    await client().trading.configureSimulation({
      deskId: flow.desk.id,
      scenario: "immediate_fill",
    });
    const cancel = {
      deskId: flow.desk.id,
      executionId: execution.id,
      clientRequestId: randomUUID(),
    };
    const unknown = await flow.tradeClient.trading.cancelSimulation(cancel);
    expect(unknown.receipt.status).toBe("unknown");
    expect((await client().trading.desk({ deskId: flow.desk.id })).grants[0]).toMatchObject({
      usedCny: "2500",
      reservedCny: "2500",
    });
    expect(await flow.tradeClient.trading.cancelSimulation(cancel)).toEqual(unknown);
    const done = await client().trading.reconcileExecution({
      deskId: flow.desk.id,
      executionId: execution.id,
      expectedSequence: unknown.receipt.sequence,
    });
    expect(done.receipt).toMatchObject({ status: "cancelled", fills: execution.receipt.fills });
    expect((await client().trading.desk({ deskId: flow.desk.id })).grants[0]).toMatchObject({
      usedCny: "2500",
      reservedCny: "0",
    });
    expect((await flow.tradeClient.trading.cancelSimulation(cancel)).receipt).toEqual(done.receipt);
  });

  it.each(["rejected", "pending", "unavailable"] as const)(
    "handles %s without fabricating fills",
    async (scenario) => {
      const flow = await setup();
      await flow.enable();
      const grant = await flow.grant("5000", "5000");
      await client().trading.configureSimulation({ deskId: flow.desk.id, scenario });
      const execution = await client().trading.executeSimulation(
        flow.request(randomUUID(), grant.id),
      );
      expect(execution.receipt.fills).toEqual([]);
      const reconciled = await client().trading.reconcileExecution({
        deskId: flow.desk.id,
        executionId: execution.id,
        expectedSequence: 1,
      });
      expect(reconciled).toEqual(execution);
      const cancelled = await flow.tradeClient.trading.cancelSimulation({
        deskId: flow.desk.id,
        executionId: execution.id,
        clientRequestId: randomUUID(),
      });
      expect(cancelled.receipt.status).toBe(
        scenario === "unavailable" ? "unknown" : scenario === "rejected" ? "rejected" : "cancelled",
      );
      expect((await client().trading.desk({ deskId: flow.desk.id })).grants[0]).toMatchObject({
        usedCny: "0",
        reservedCny: scenario === "unavailable" ? "5000" : "0",
      });
      const tracked = await client().trading.reconcileExecution({
        deskId: flow.desk.id,
        executionId: execution.id,
        expectedSequence: cancelled.receipt.sequence,
      });
      expect(tracked).toEqual(cancelled);
      if (scenario === "rejected") {
        const next = await client().trading.prepareIntent({
          deskId: flow.desk.id,
          analysisId: flow.analysis.id,
          expiresAt: expiresAt(),
        });
        await client().trading.configureSimulation({
          deskId: flow.desk.id,
          scenario: "immediate_fill",
        });
        expect(
          (
            await client().trading.executeSimulation({
              ...flow.request(randomUUID(), grant.id),
              intentId: next.id,
              expectedIntentHash: next.intent.intentHash,
            })
          ).receipt.status,
        ).toBe("filled");
      }
    },
  );

  it("restricts scenario settings to a confirmed owner and serializes cancel versus reconcile", async () => {
    const flow = await setup();
    await flow.enable();
    await flow.approve();
    const policy = { deskId: flow.desk.id, scenario: "partial_fill" as const };
    await expect(client(owner, false).trading.configureSimulation(policy)).rejects.toThrow();
    await expect(flow.tradeClient.trading.configureSimulation(policy)).rejects.toMatchObject(
      reason("FORBIDDEN"),
    );
    await client().trading.configureSimulation(policy);
    const execution = await client().trading.executeSimulation(flow.request());
    await Promise.all([
      client().trading.reconcileExecution({
        deskId: flow.desk.id,
        executionId: execution.id,
        expectedSequence: 1,
      }),
      flow.tradeClient.trading.cancelSimulation({
        deskId: flow.desk.id,
        executionId: execution.id,
        clientRequestId: randomUUID(),
      }),
    ]);
    const latest = await client().trading.executionByRequest({
      deskId: flow.desk.id,
      clientRequestId: execution.clientRequestId,
    });
    expect(["filled", "cancelled"]).toContain(latest.receipt.status);
    expect(latest.receipts).toHaveLength(2);
    expect(latest.receipts[0]).toEqual(execution.receipt);
  });
});

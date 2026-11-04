import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, TradingScope } from "@rakazo/contracts";
import {
  TradingAnalysisSchema,
  TradingExecutionSchema,
  TradingStoredIntentSchema,
} from "@rakazo/contracts";
import { createDb, createTradingBotService, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "../../../packages/adapters/src/run-tool-selection.js";
import { tradingTools } from "../../../packages/adapters/src/run-tools-trading.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("bound Bot trading tools (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const suffix = randomUUID(),
    organizationId = `bot-trading-${suffix}`;
  const actor: Actor = {
    userId: `bot-owner-${suffix}`,
    spaceId: `bot-space-${suffix}`,
    email: `bot-owner-${suffix}@example.test`,
    isDeploymentOwner: false,
  };
  const now = new Date("2026-11-03T00:00:00.000Z");
  const secrets = new EncryptedSecretStore("synthetic-workspace-encryption-key");
  const client = (who = actor) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        secrets,
        env: {},
        tradingClock: () => now,
        auth: { hasRecentIdentityConfirmation: async () => true },
      } as unknown as RouterDeps),
      { context: { actor: who, sessionId: "human-test-session" } },
    );
  const gateway = () => createTradingBotService(db.prisma, () => now);
  async function call(botId: string, args: Record<string, unknown>, who = actor) {
    const context = {
      deps: { trading: gateway() },
      run: { userId: who.userId, spaceId: who.spaceId },
      bot: { id: botId },
    } as unknown as Parameters<typeof tradingTools.trading>[0];
    const invocation = { args, finish: async (result: unknown) => result } as unknown as Parameters<
      typeof tradingTools.trading
    >[1];
    return runAsTenant(who, () => tradingTools.trading(context, invocation));
  }
  async function setup(
    kind: TradingScope["subjectKind"] = "retailer",
    stage: TradingScope["stage"] = "day_ahead",
  ) {
    const desk = await client().trading.createDesk({
      scope: {
        subjectId: "synthetic-subject",
        subjectKind: kind,
        accountId: "synthetic-account",
        assetId: "synthetic-asset",
        region: "CN-SD",
        marketId: "synthetic",
        productId: "energy",
        stage,
        environment: "simulation",
      },
      algorithmApproverUserId: actor.userId,
      tradeApproverUserId: actor.userId,
    });
    async function bot(role: "spot" | "mid_long_term" | "risk" | "review" = "spot") {
      const id = randomUUID();
      await runAsSystem("synthetic trading Bot fixture", () =>
        db.prisma.bot.create({
          data: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: role,
            color: "blue",
            tradingRole: role,
          },
        }),
      );
      await client().trading.bindBot({ deskId: desk.id, botId: id, role });
      return id;
    }
    async function prepare(botId: string) {
      const analysis = TradingAnalysisSchema.parse(
        await call(botId, { operation: "analyze", deskId: desk.id }),
      );
      const intent = TradingStoredIntentSchema.parse(
        await call(botId, { operation: "prepare", deskId: desk.id, analysisId: analysis.id }),
      );
      const version = (await client().trading.desk({ deskId: desk.id })).versions.find(
        (row) => row.id === intent.versionId,
      )!;
      const enable = () =>
        client().trading.approveAlgorithm({
          deskId: desk.id,
          versionId: version.id,
          expectedArtifactHash: version.artifactHash,
        });
      const approve = () =>
        client().trading.approveIntent({
          deskId: desk.id,
          intentId: intent.id,
          expectedIntentHash: intent.intent.intentHash,
        });
      const request = (grantId?: string) => ({
        operation: "execute",
        deskId: desk.id,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
        clientRequestId: randomUUID(),
        ...(grantId ? { grantId } : {}),
      });
      return { analysis, intent, version, enable, approve, request };
    }
    return { desk, bot, prepare };
  }
  beforeAll(() =>
    runAsSystem("Bot trading fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic owner" },
      });
      await db.prisma.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Synthetic trading",
          createdAt: now,
        },
      });
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: actor.spaceId,
          organizationId,
          name: "Trading",
          createdByUserId: actor.userId,
        },
      });
      await db.prisma.member.create({
        data: {
          id: `member-${suffix}`,
          organizationId,
          userId: actor.userId,
          role: "member",
          createdAt: now,
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: `space-member-${suffix}`,
          organizationId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          createdAt: now,
        },
      });
    }),
  );
  beforeEach(() =>
    runAsSystem("isolated business fixture", async () => {
      actor.spaceId = randomUUID();
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: actor.spaceId,
          organizationId,
          name: "Synthetic business",
          createdByUserId: actor.userId,
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          organizationId,
          userId: actor.userId,
          role: "owner",
          createdAt: now,
        },
      });
    }),
  );
  afterAll(() =>
    runAsSystem("Bot trading cleanup", async () => {
      if (!db) return;
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: actor.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }),
  );

  async function workspace(name = "Synthetic business scope", newSpace = false) {
    return (newSpace ? client().trading.createBusinessScope : client().trading.createWorkspace)({
      name,
      scope: {
        subjectId: "synthetic-subject",
        subjectKind: "retailer",
        accountId: "synthetic-account",
        assetId: "synthetic-asset",
        region: "CN-SD",
        marketId: "synthetic",
        productId: "energy",
        environment: "simulation",
      },
      algorithmApproverUserId: actor.userId,
      tradeApproverUserId: actor.userId,
    });
  }
  it("creates one isolated business atomically, retries safely and rejects a second configuration", async () => {
    const configured = await workspace();
    await expect(
      client().trading.createWorkspace({
        name: "Other account",
        scope: { ...configured.scope, accountId: "another-account" },
        algorithmApproverUserId: actor.userId,
        tradeApproverUserId: actor.userId,
      }),
    ).rejects.toMatchObject({ data: { reason: "SCOPE_MISMATCH" } });
    const input = {
      id: randomUUID(),
      name: "Fresh business",
      scope: configured.scope,
      algorithmApproverUserId: actor.userId,
      tradeApproverUserId: actor.userId,
    };
    const [created, concurrent] = await Promise.all([
      client().trading.createBusinessScope(input),
      client().trading.createBusinessScope(input),
    ]);
    expect(concurrent).toEqual(created);
    expect(created.spaceId).not.toBe(actor.spaceId);
    expect(await client().trading.createBusinessScope(input)).toEqual(created);
    const next = client({ ...actor, spaceId: created.spaceId });
    expect(await next.bots.list()).toMatchObject([{ businessSupervisor: true, tradingRole: null }]);
    expect(await next.trading.desks({})).toEqual([]);
    expect(await next.trading.interfaces({ workspaceId: created.id })).toEqual([]);
    expect((await client().trading.workspaces({})).map((row) => row.id)).toEqual([configured.id]);
    await expect(
      client({ ...actor, spaceId: "not-a-member" }).trading.createBusinessScope({
        ...input,
        id: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      client().trading.createBusinessScope({
        ...input,
        id: randomUUID(),
        tradeApproverUserId: "outsider",
      }),
    ).rejects.toThrow();
  });
  it("groups four templates under one business scope with independent stage authority", async () => {
    const scope = await workspace();
    const bots = await Promise.all(
      (["mid_long_term", "spot", "risk", "review"] as const).map((tradingRole) =>
        client().bots.create({ name: tradingRole, tradingRole, tradingWorkspaceId: scope.id }),
      ),
    );
    const saved = (await client().trading.workspaces({})).find((row) => row.id === scope.id)!;
    expect(saved.botIds).toEqual(expect.arrayContaining(bots.map((bot) => bot.id)));
    expect(saved.botIds).toHaveLength(bots.length + 1);
    expect(saved.deskIds).toHaveLength(4);
    for (const [index, bot] of bots.entries()) {
      const desks = await client().trading.desks({ botId: bot.id });
      expect(desks).toHaveLength([1, 3, 4, 4][index]!);
      for (const desk of desks) {
        const state = await client().trading.desk({ deskId: desk.id });
        expect(state.grants).toEqual([]);
        expect(state.versions).toEqual([]);
        const learning = await client().trading.learningState({ deskId: desk.id });
        expect(learning.plans.some((plan) => plan.botId === bot.id)).toBe(true);
      }
    }
    const other = await workspace("Separate business scope", true);
    const otherClient = client({ ...actor, spaceId: other.spaceId });
    await expect(
      otherClient.trading.connectWorkspaceBot({ workspaceId: other.id, botId: bots[0]!.id }),
    ).rejects.toThrow();
    await expect(
      client().trading.connectWorkspaceBot({ workspaceId: other.id, botId: bots[0]!.id }),
    ).rejects.toThrow();
    const cloned = await otherClient.bots.create({
      name: "Another term Bot",
      tradingRole: "mid_long_term",
    });
    expect(cloned.id).not.toBe(bots[0]!.id);
    expect(cloned.spaceId).toBe(other.spaceId);
    const linked = (await otherClient.trading.workspaces({}))[0]!;
    expect(linked.botIds).toContain(cloned.id);
    expect(linked.botIds).toHaveLength(2);
    expect(linked.deskIds.every((id) => !saved.deskIds.includes(id))).toBe(true);
    await client().trading.connectWorkspaceBot({ workspaceId: scope.id, botId: bots[0]!.id });
    expect(
      (await client().trading.workspaces({})).find((row) => row.id === scope.id)!.deskIds,
    ).toHaveLength(4);
  });
  it("rolls back Bot creation for a missing business scope and rejects general Bot membership", async () => {
    const before = await client().bots.list();
    await expect(
      client().bots.create({
        name: "Rejected Bot",
        tradingRole: "spot",
        tradingWorkspaceId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await client().bots.list()).toHaveLength(before.length);
    const scope = await workspace();
    await expect(client().bots.create({ name: "General" })).rejects.toThrow(
      "General Bots require a general workspace",
    );
    const generalSpace = await client().spaces.create({
      name: "Synthetic general",
      kind: "general",
    });
    const general = await client({ ...actor, spaceId: generalSpace.id }).bots.create({
      name: "General",
    });
    await expect(
      client().trading.connectWorkspaceBot({ workspaceId: scope.id, botId: general.id }),
    ).rejects.toThrow();
    expect(
      (await client().trading.workspaces({})).find((row) => row.id === scope.id)!.botIds,
    ).toHaveLength(1);
  });
  it("stores multiple data APIs per scope with encrypted credentials and revision checks", async () => {
    const scope = await workspace(),
      other = await workspace("Separate business", true);
    const input = {
      id: randomUUID(),
      workspaceId: scope.id,
      name: "Synthetic prices",
      purpose: "market_data" as const,
      config: {
        transport: "http" as const,
        url: "https://api.example.test/prices",
        method: "GET" as const,
        query: { region: "CN-SD" },
        body: "",
        auth: "header" as const,
        authName: "X-API-Key",
      },
      expectedRevision: 0,
      secret: "synthetic-test-token",
    };
    const saved = await client().trading.saveInterface(input);
    expect(saved).toMatchObject({ hasSecret: true, status: "configured", revision: 1 });
    expect(JSON.stringify(saved)).not.toContain(input.secret);
    const persisted = await runAsSystem("inspect encrypted fixture", () =>
      db.prisma.tradingWorkspaceInterface.findUniqueOrThrow({ where: { id: saved.id } }),
    );
    const credential = await runAsSystem("inspect encrypted fixture", () =>
      db.prisma.secret.findUniqueOrThrow({ where: { id: persisted.secretId! } }),
    );
    expect(credential.ciphertext).not.toContain(input.secret);
    expect(await secrets.load(credential.ciphertext, credential.id)).toBe(input.secret);
    const { secret: _secret, ...update } = input;
    const edited = await client().trading.saveInterface({
      ...update,
      name: "Renamed prices",
      expectedRevision: 1,
    });
    expect(edited).toMatchObject({ hasSecret: true, revision: 2 });
    await expect(
      client().trading.saveInterface({ ...update, expectedRevision: 1 }),
    ).rejects.toThrow("Interface changed");
    await expect(
      client().trading.saveInterface({ ...update, workspaceId: other.id, expectedRevision: 2 }),
    ).rejects.toThrow();
    const publicApi = await client().trading.saveInterface({
      ...update,
      id: randomUUID(),
      name: "Synthetic forecast",
      purpose: "forecasts",
      config: { ...input.config, url: "https://api.example.test/forecast", auth: "none" },
      expectedRevision: 0,
    });
    expect(publicApi.hasSecret).toBe(false);
    expect(await client().trading.interfaces({ workspaceId: scope.id })).toHaveLength(2);
    await expect(client().trading.interfaces({ workspaceId: other.id })).rejects.toThrow();
    expect(
      await client({ ...actor, spaceId: other.spaceId }).trading.interfaces({
        workspaceId: other.id,
      }),
    ).toEqual([]);
    await expect(
      client({ ...actor, userId: `outsider-${suffix}` }).trading.interfaces({
        workspaceId: scope.id,
      }),
    ).rejects.toThrow();
    await expect(
      client().trading.removeInterface({
        workspaceId: scope.id,
        id: saved.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("Interface changed");
    await client().trading.removeInterface({
      workspaceId: scope.id,
      id: saved.id,
      expectedRevision: 2,
    });
    expect(
      await runAsSystem("check secret removal", () =>
        db.prisma.secret.count({ where: { id: credential.id } }),
      ),
    ).toBe(0);
  });
  it("requires an accessible MCP connection and does not grant Bot tools", async () => {
    const scope = await workspace();
    const input = {
      id: randomUUID(),
      workspaceId: scope.id,
      name: "Synthetic MCP",
      purpose: "rules" as const,
      config: { transport: "mcp" as const, serverId: randomUUID() },
      expectedRevision: 0,
    };
    await expect(client().trading.saveInterface(input)).rejects.toThrow("MCP connection not found");
    const server = await runAsSystem("synthetic MCP fixture", () =>
      db.prisma.mcpServer.create({
        data: {
          id: randomUUID(),
          userId: actor.userId,
          spaceId: actor.spaceId,
          name: "Synthetic MCP",
          slug: `synthetic-${randomUUID()}`,
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
        },
      }),
    );
    const saved = await client().trading.saveInterface({
      ...input,
      config: { transport: "mcp", serverId: server.id },
    });
    expect(saved).toMatchObject({ hasSecret: false, status: "configured" });
    expect(
      await runAsSystem("check MCP assignments", () =>
        db.prisma.botMcpServer.count({ where: { serverId: server.id } }),
      ),
    ).toBe(0);
  });

  it.each(["mid_long_term", "spot", "risk", "review"] as const)(
    "creates a %s template and atomically configures its scope without granting authority",
    async (tradingRole) => {
      const bot = await client().bots.create({ name: `Synthetic ${tradingRole}`, tradingRole });
      expect(bot.tradingRole).toBe(tradingRole);
      expect(bot.instructions.length).toBeGreaterThan(0);
      expect((await client().bots.get({ botId: bot.id })).tradingRole).toBe(tradingRole);
      expect(await client().trading.desks({ botId: bot.id })).toEqual([]);
      const unrelated = await setup();
      const stage = tradingRole === "mid_long_term" ? "mid_long_term" : "day_ahead";
      const desk = await client().trading.createDesk({
        scope: { ...unrelated.desk.scope, stage },
        algorithmApproverUserId: actor.userId,
        tradeApproverUserId: actor.userId,
        botId: bot.id,
      });
      expect(await client().trading.desks({ botId: bot.id })).toEqual([desk]);
      const state = await client().trading.desk({ deskId: desk.id });
      expect(state.bindings).toMatchObject([{ botId: bot.id, role: tradingRole }]);
      expect(state.versions).toEqual([]);
      expect(state.grants).toEqual([]);
      expect(state.executions).toEqual([]);
      expect((await client().trading.learningState({ deskId: desk.id })).plans).toMatchObject([
        { botId: bot.id, schedule: { time: "02:00", timezone: "Asia/Shanghai", active: true } },
      ]);
      // A caller cannot turn a read-only template into a trader by rebinding it.
      await expect(
        client().trading.bindBot({
          deskId: desk.id,
          botId: bot.id,
          role: tradingRole === "risk" ? "spot" : "risk",
        }),
      ).rejects.toMatchObject({ data: { reason: "SCOPE_MISMATCH" } });
      if (tradingRole === "risk" || tradingRole === "review") {
        expect(await call(bot.id, { operation: "analyze", deskId: desk.id })).toMatchObject({
          code: "FORBIDDEN",
        });
      }
    },
  );

  it("rejects a mismatched template stage without leaving a scope or learning plan", async () => {
    const bot = await client().bots.create({
      name: "Synthetic term bot",
      tradingRole: "mid_long_term",
    });
    const flow = await setup();
    const before = await client().trading.desks({});
    await expect(
      client().trading.createDesk({
        scope: flow.desk.scope,
        botId: bot.id,
        algorithmApproverUserId: actor.userId,
        tradeApproverUserId: actor.userId,
      }),
    ).rejects.toMatchObject({ data: { reason: "SCOPE_MISMATCH" } });
    expect(await client().trading.desks({})).toEqual(before);
    expect(await client().trading.desks({ botId: bot.id })).toEqual([]);
    await expect(client().trading.desks({ botId: "unowned-bot" })).rejects.toMatchObject({
      data: { reason: "NOT_FOUND" },
    });
  });

  it.each(["retailer", "generator", "storage"] as const)(
    "runs %s via the actual registered tool handler and two human approvals",
    async (kind) => {
      const flow = await setup(kind),
        botId = await flow.bot();
      expect(await call(botId, { operation: "scopes" })).toMatchObject([
        { deskId: flow.desk.id, role: "spot" },
      ]);
      const prepared = await flow.prepare(botId);
      expect(prepared.intent.botId).toBe(botId);
      await expect(call(botId, prepared.request())).resolves.toMatchObject({
        code: "ALGORITHM_NOT_APPROVED",
      });
      await prepared.enable();
      await expect(call(botId, prepared.request())).resolves.toMatchObject({
        code: "TRADE_NOT_APPROVED",
      });
      await prepared.approve();
      const request = prepared.request();
      const receipt = TradingExecutionSchema.parse(await call(botId, request));
      expect(receipt.receipt.status).toBe("filled");
      expect(receipt.receipt.source.kind).toBe("synthetic");
      expect(TradingExecutionSchema.parse(await call(botId, request))).toEqual(receipt);
    },
  );
  it.each(["risk", "review"] as const)(
    "keeps %s Bots limited to authorized reads",
    async (role) => {
      const flow = await setup(),
        botId = await flow.bot(role);
      expect(await call(botId, { operation: "context", deskId: flow.desk.id })).toMatchObject({
        desk: { id: flow.desk.id },
      });
      expect(await call(botId, { operation: "analyze", deskId: flow.desk.id })).toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );
  it("checks business stage separately from role descriptions", async () => {
    const flow = await setup("retailer", "mid_long_term"),
      botId = await flow.bot("mid_long_term");
    const prepared = await flow.prepare(botId);
    expect(prepared.analysis.snapshot.scope.stage).toBe("mid_long_term");
    await expect(
      client().trading.bindBot({ deskId: flow.desk.id, botId, role: "spot" }),
    ).rejects.toMatchObject({ data: { reason: "SCOPE_MISMATCH" } });
  });
  it("cannot approve or forge identity in tool arguments", async () => {
    const flow = await setup(),
      botId = await flow.bot();
    expect(
      await call(botId, { operation: "approve", deskId: flow.desk.id, approved: true }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await call(botId, { operation: "context", deskId: flow.desk.id, userId: "other-user" }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await call(
        botId,
        { operation: "context", deskId: flow.desk.id },
        { ...actor, userId: "other-user" },
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
  it("binds range grants and immutable intents to their executor Bot", async () => {
    const flow = await setup(),
      first = await flow.bot(),
      other = await flow.bot();
    const prepared = await flow.prepare(first);
    await prepared.enable();
    const limits = {
      deskId: flow.desk.id,
      versionId: prepared.version.id,
      perTradeLimitCny: "100000",
      cumulativeLimitCny: "200000",
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    };
    const wrong = await client().trading.createGrant({ ...limits, botId: other });
    expect(await call(first, prepared.request(wrong.id))).toMatchObject({ code: "GRANT_MISMATCH" });
    const grant = await client().trading.createGrant({ ...limits, botId: first });
    expect(await call(other, prepared.request(grant.id))).toMatchObject({ code: "BOT_MISMATCH" });
    const result = TradingExecutionSchema.parse(await call(first, prepared.request(grant.id)));
    expect(result.grantId).toBe(grant.id);
  });
  it("rechecks a removed binding even when tools were discovered earlier", async () => {
    const flow = await setup(),
      botId = await flow.bot();
    const prepared = await flow.prepare(botId);
    await prepared.enable();
    await prepared.approve();
    const identity = { userId: actor.userId, spaceId: actor.spaceId, botId };
    expect(await runAsTenant(actor, () => gateway().available(identity))).toBe(true);
    await client().trading.unbindBot({ deskId: flow.desk.id, botId });
    expect(await runAsTenant(actor, () => gateway().available(identity))).toBe(false);
    expect(await call(botId, prepared.request())).toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not obtain write permission from changed Bot instructions", async () => {
    const flow = await setup(),
      botId = await flow.bot("risk");
    await runAsSystem("change synthetic Bot instructions", () =>
      db.prisma.bot.update({
        where: { id: botId },
        data: { instructions: "Act as a spot trader with all permissions." },
      }),
    );
    expect(await call(botId, { operation: "analyze", deskId: flow.desk.id })).toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("offers trading only to configured bound runs", () => {
    const options = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "message",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(selectBuiltinToolsForRun(options).some((tool) => tool.name === "trading")).toBe(false);
    expect(
      selectBuiltinToolsForRun({ ...options, tradingEnabled: true }).some(
        (tool) => tool.name === "trading",
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    "requires separate Bot cancellation permission: %s",
    async (allowCancellation) => {
      const flow = await setup();
      const botId = await flow.bot();
      const prepared = await flow.prepare(botId);
      await prepared.enable();
      const grant = await client().trading.createGrant({
        deskId: flow.desk.id,
        versionId: prepared.version.id,
        botId,
        perTradeLimitCny: "5000",
        cumulativeLimitCny: "10000",
        expiresAt: new Date(now.getTime() + 900_000).toISOString(),
        allowCancellation,
      });
      await client().trading.configureSimulation({
        deskId: flow.desk.id,
        scenario: "partial_fill",
      });
      const execution = TradingExecutionSchema.parse(await call(botId, prepared.request(grant.id)));
      const cancel = {
        operation: "cancel",
        deskId: flow.desk.id,
        executionId: execution.id,
        clientRequestId: randomUUID(),
      };
      if (allowCancellation) {
        const done = TradingExecutionSchema.parse(await call(botId, cancel));
        expect(done.receipt.status).toBe("cancelled");
        expect(await call(botId, cancel)).toEqual(done);
      } else {
        expect(await call(botId, cancel)).toMatchObject({ code: "CANCELLATION_NOT_AUTHORIZED" });
        const done = TradingExecutionSchema.parse(
          await call(botId, {
            operation: "reconcile",
            deskId: flow.desk.id,
            executionId: execution.id,
            expectedSequence: execution.receipt.sequence,
          }),
        );
        expect(done.receipt.status).toBe("filled");
      }
    },
  );
});

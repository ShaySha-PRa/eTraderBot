import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConnector } from "../../../packages/adapters/src/mcp-connector.js";
import { applyTool } from "../../../packages/adapters/src/run-tools.js";
import { tradingTools } from "../../../packages/adapters/src/run-tools-trading.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import { availableInSpace, mcpAvailableToBot } from "../../../packages/db/src/availability.js";
import { createDb } from "../../../packages/db/src/client.js";
import { LocalKeyProvider, masterKeysFromEnv } from "../../../packages/db/src/content-keys.js";
import { crossSpaceCommunicationAllowed } from "../../../packages/db/src/cross-space-communication.js";
import { createRepos } from "../../../packages/db/src/repos.js";
import { runAsSystem, runAsTenant } from "../../../packages/db/src/row-security.js";
import {
  setSpaceSettingOverride,
  settingsTarget,
} from "../../../packages/db/src/space-settings.js";
import { createTradingBotService } from "../../../packages/db/src/trading-bots.js";
import { createWorkspaceAccessService } from "../../../packages/db/src/workspace-access.js";
import { requireIsolatedBot } from "../../../packages/db/src/workspace-isolation.js";
import {
  migrateWorkspaceOwnership,
  preflightWorkspaceMigration,
} from "../../../packages/db/src/workspace-migration.js";
import { MarkdownMemoryStore } from "../../../packages/memory/src/index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("workspace isolation (PostgreSQL)", () => {
  const uid = randomUUID(),
    org = randomUUID();
  let db: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof createDb>;
  const actor = (spaceId: string): Actor => ({
    spaceId,
    userId: uid,
    email: "isolation@example.test",
    isDeploymentOwner: false,
  });
  const system = <T>(f: () => Promise<T>) =>
    runAsSystem("synthetic workspace isolation fixture", f);
  async function space(kind: "trading" | "general") {
    return system(async () => {
      const row = await db.prisma.space.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          name: `Synthetic ${kind}`,
          kind,
          createdByUserId: uid,
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          spaceId: row.id,
          userId: uid,
          role: "owner",
          createdAt: new Date(),
        },
      });
      return actor(row.id);
    });
  }
  const bot = (who: Actor, tradingRole?: "spot") =>
    system(() =>
      db.prisma.bot.create({
        data: {
          id: randomUUID(),
          spaceId: who.spaceId,
          userId: uid,
          name: "Synthetic",
          color: "blue",
          tradingRole,
        },
      }),
    );
  beforeAll(() =>
    system(async () => {
      const keyProvider = new LocalKeyProvider([
        { id: "isolation-test", key: randomBytes(32) },
        ...masterKeysFromEnv(),
      ]);
      db = createDb(process.env.DATABASE_URL!, { encryptContent: true, keyProvider });
      admin = createDb(process.env.DATABASE_MIGRATION_URL!, { encryptContent: true, keyProvider });
      await db.prisma.user.create({
        data: { id: uid, email: `${uid}@example.test`, name: "Synthetic owner" },
      });
      await db.prisma.organization.create({
        data: { id: org, name: "Synthetic", slug: org, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId: uid,
          role: "member",
          createdAt: new Date(),
        },
      });
    }),
  );
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await admin?.prisma.$disconnect();
    await admin?.pool.end();
  });

  it("rejects incompatible creation in repository and SQL, immutable role and foreign computers", () =>
    system(async () => {
      const trade = await space("trading"),
        general = await space("general");
      await expect(
        createRepos(db.prisma).createBot(trade, {
          name: "ordinary",
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      ).rejects.toThrow("General Bots require");
      await expect(
        createRepos(db.prisma).createBot(general, {
          name: "trader",
          tradingRole: "spot",
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      ).rejects.toThrow("Trading templates");
      await expect(bot(trade)).rejects.toThrow("Bot role does not match");
      await expect(bot(general, "spot")).rejects.toThrow("Bot role does not match");
      const ordinary = await bot(general),
        trader = await bot(trade, "spot");
      await expect(
        db.prisma.bot.update({ where: { id: trader.id }, data: { tradingRole: "risk" } }),
      ).rejects.toThrow("immutable");
      const computer = await db.prisma.computer.create({
        data: {
          spaceId: trade.spaceId,
          userId: uid,
          kind: "docker",
          scopeKey: randomUUID(),
          homeKey: randomUUID(),
        },
      });
      await expect(
        db.prisma.bot.update({ where: { id: ordinary.id }, data: { computerId: computer.id } }),
      ).rejects.toThrow("another workspace");
      await expect(requireIsolatedBot(db.prisma, { ...trade, botId: ordinary.id })).rejects.toThrow(
        "unavailable",
      );
    }));

  it("does not expose trading skills through allSpaces, even under system worker context", () =>
    system(async () => {
      const trade = await space("trading"),
        general = await space("general"),
        otherTrade = await space("trading");
      const skill = await db.prisma.agentSkill.create({
        data: {
          spaceId: trade.spaceId,
          userId: uid,
          name: "synthetic-skill",
          description: "Synthetic",
          content: "Scoped",
          allSpaces: true,
        },
      });
      for (const who of [general, otherTrade]) {
        expect(
          await db.prisma.agentSkill.findFirst({
            where: { id: skill.id, ...availableInSpace(who) },
          }),
        ).toBeNull();
        expect(
          await runAsTenant(who, () => db.prisma.agentSkill.findFirst({ where: { id: skill.id } })),
        ).toBeNull();
      }
      expect(
        await runAsTenant(trade, () => db.prisma.agentSkill.findFirst({ where: { id: skill.id } })),
      ).not.toBeNull();
      const install = await db.prisma.capabilityInstall.create({
        data: {
          spaceId: trade.spaceId,
          userId: uid,
          name: "Synthetic HTTP",
          kind: "tool-source",
          source: "https://example.test/schema",
          allSpaces: true,
        },
      });
      const mcp = await db.prisma.mcpServer.create({
        data: {
          spaceId: trade.spaceId,
          userId: uid,
          slug: "synthetic",
          name: "Synthetic MCP",
          transport: "streamable_http",
          endpoint: "https://example.test/mcp",
          allSpaces: true,
          allBots: true,
        },
      });
      const local = await db.prisma.mcpServer.create({
        data: {
          spaceId: general.spaceId,
          userId: uid,
          slug: "local",
          name: "Local",
          transport: "stdio",
          command: "node",
          allBots: true,
        },
      });
      expect(
        await db.prisma.mcpServer.findFirst({
          where: { id: local.id, ...mcpAvailableToBot(general) },
        }),
      ).toBeNull();
      for (const who of [general, otherTrade]) {
        expect(
          await db.prisma.capabilityInstall.findFirst({
            where: { id: install.id, ...availableInSpace(who) },
          }),
        ).toBeNull();
        expect(
          await db.prisma.mcpServer.findFirst({ where: { id: mcp.id, ...mcpAvailableToBot(who) } }),
        ).toBeNull();
        await runAsTenant(who, async () => {
          expect(await db.prisma.mcpServer.findFirst({ where: { id: mcp.id } })).toBeNull();
          expect(
            await db.prisma.capabilityInstall.findFirst({ where: { id: install.id } }),
          ).toBeNull();
        });
      }
      const trader = await bot(trade, "spot"),
        ordinary = await bot(general);
      expect(
        await db.prisma.$transaction((tx) =>
          crossSpaceCommunicationAllowed(tx, trader.id, ordinary.id),
        ),
      ).toBe(false);
      expect(await settingsTarget(db.prisma, general, "credentials")).toBe("space");
      await expect(
        setSpaceSettingOverride(db.prisma, general, "credentials", false),
      ).rejects.toThrow("cannot be disabled");
    }));

  it("grants only selected records to one general Bot, audits reads and denies revocation/cross-business access", () =>
    system(async () => {
      const source = await space("trading"),
        target = await space("general"),
        other = await space("trading");
      const recipient = await bot(target),
        stranger = await bot(target);
      const memory = await db.prisma.memoryDocument.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          scope: "user",
          path: "selected.md",
          content: "Synthetic read-only material",
        },
      });
      const service = createWorkspaceAccessService(db.prisma);
      const identity = { ...target, botId: recipient.id };
      expect(await runAsTenant(target, () => service.received(identity))).toEqual([]);
      await expect(service.read(identity, "missing")).rejects.toThrow("unavailable");
      await expect(
        service.grant(other, {
          id: randomUUID(),
          recipientBotId: recipient.id,
          kind: "memory",
          resourceId: memory.id,
        }),
      ).rejects.toThrow("unavailable");
      const grant = await runAsTenant(source, () =>
        service.grant(source, {
          id: randomUUID(),
          recipientBotId: recipient.id,
          kind: "memory",
          resourceId: memory.id,
        }),
      );
      expect(
        (await runAsTenant(target, () => service.read(identity, grant.id))).material.content,
      ).toMatchObject({ text: "Synthetic read-only material" });
      await expect(service.read({ ...target, botId: stranger.id }, grant.id)).rejects.toThrow(
        "unavailable",
      );
      await expect(service.read({ ...source, botId: recipient.id }, grant.id)).rejects.toThrow(
        "unavailable",
      );
      await runAsTenant(target, async () => {
        expect(
          await db.prisma.memoryDocument.updateMany({
            where: { id: memory.id },
            data: { content: "tampered" },
          }),
        ).toEqual({ count: 0 });
        expect(await db.prisma.memoryDocument.findFirst({ where: { id: memory.id } })).toBeNull();
      });
      await service.revoke(source, grant.id);
      await expect(service.read(identity, grant.id)).rejects.toThrow("revoked");
      expect(await service.received(identity)).toEqual([]);
      expect((await service.audit(source)).map((row) => row.action)).toEqual(
        expect.arrayContaining(["granted", "read", "read_denied", "revoked"]),
      );
      const again = await service.grant(source, {
        id: randomUUID(),
        recipientBotId: recipient.id,
        kind: "memory",
        resourceId: memory.id,
      });
      expect(again.id).not.toBe(grant.id);
      await db.prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: source.spaceId, userId: uid } },
      });
      expect(await service.received(identity)).toEqual([]);
      await expect(service.read(identity, again.id)).rejects.toThrow("unavailable");
    }));

  it("rejects forged runtime contexts, host/file access and cached MCP calls across the boundary", () =>
    system(async () => {
      const trade = await space("trading"),
        general = await space("general");
      const ordinary = await bot(general),
        trader = await bot(trade, "spot");
      const context = {
        ...general,
        botId: ordinary.id,
        operationId: "test",
        traceId: "test",
        signal: new AbortController().signal,
      } satisfies AdapterContext;
      const ctx = {
        deps: { prisma: db.prisma, trading: createTradingBotService(db.prisma) },
        run: { ...general, botId: ordinary.id },
        bot: { id: ordinary.id },
        context,
        state: {},
      } as unknown as Parameters<typeof applyTool>[0];
      expect(
        await applyTool(ctx, "user_computer_shell", { command: "synthetic" }, "test"),
      ).toMatchObject({ code: "WORKSPACE_ISOLATION" });
      await expect(
        applyTool(
          { ...ctx, run: { ...ctx.run, spaceId: trade.spaceId } },
          "write_file",
          { path: "rules.md", content: "tamper" },
          "test",
        ),
      ).rejects.toThrow("unavailable");
      for (const operation of ["scopes", "analyze", "prepare", "execute", "learn", "weather"]) {
        const call = {
          args: { operation },
          finish: async (value: unknown) => value,
        } as unknown as Parameters<typeof tradingTools.trading>[1];
        expect(await tradingTools.trading(ctx, call)).toMatchObject({ code: "FORBIDDEN" });
      }
      const memory = new MarkdownMemoryStore(db.prisma);
      await memory.commit(
        { scope: "user", path: "rules.md", content: "original" },
        { ...context, ...trade },
      );
      await memory.commit({ scope: "user", path: "rules.md", content: "general notes" }, context);
      expect(
        (await memory.read({ scope: "user", path: "rules.md" }, { ...context, ...trade }))
          .documents[0]?.content,
      ).toBe("original");
      const server = await db.prisma.mcpServer.create({
        data: {
          spaceId: trade.spaceId,
          userId: uid,
          name: "Trade MCP",
          slug: "trade",
          transport: "streamable_http",
          endpoint: "https://example.test/mcp",
          allSpaces: true,
          allBots: true,
        },
      });
      const connector = new McpConnector(
        db.prisma,
        new EncryptedSecretStore("synthetic-isolation-secret"),
      );
      try {
        const events = [];
        for await (const event of connector.execute(
          {
            tool: "mcp__trade__write",
            args: {},
            executionId: "test",
            route: {
              connectorId: "mcp",
              resourceId: server.id,
              resourceRevision: 1,
              toolName: "write",
            },
          },
          context,
        ))
          events.push(event);
        expect(events).toEqual([
          { type: "error", message: "MCP tool is not assigned to this bot" },
        ]);
      } finally {
        await connector.close();
      }
      expect(await requireIsolatedBot(db.prisma, { ...trade, botId: trader.id })).toMatchObject({
        tradingRole: "spot",
      });
      const host = await db.prisma.computer.create({
        data: {
          spaceId: general.spaceId,
          userId: uid,
          scopeKey: randomUUID(),
          homeKey: randomUUID(),
          kind: "desktop",
        },
      });
      await db.prisma.bot.update({ where: { id: ordinary.id }, data: { computerId: host.id } });
      await expect(
        requireIsolatedBot(db.prisma, { ...general, botId: ordinary.id }),
      ).rejects.toThrow("host computer access");
    }));

  it("moves encrypted exclusive history without moving shared memory, computers or trading evidence", () =>
    system(async () => {
      const source = await space("general");
      const ordinary = await bot(source);
      const thread = await db.prisma.thread.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          botId: ordinary.id,
          historyCompactionSummary: "Synthetic summary",
        },
      });
      const message = await db.prisma.message.create({
        data: {
          threadId: thread.id,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Synthetic chat" }],
        },
      });
      const event = await db.prisma.event.create({
        data: {
          spaceId: source.spaceId,
          threadId: thread.id,
          botId: ordinary.id,
          seq: 0,
          type: "synthetic",
          payload: { text: "Synthetic event" },
        },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          botId: ordinary.id,
          threadId: thread.id,
          prompt: "Synthetic task",
          status: "completed",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          botId: ordinary.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "message",
        },
      });
      const effect = await db.prisma.externalEffect.create({
        data: {
          spaceId: source.spaceId,
          runId: run.id,
          kind: "synthetic",
          idempotencyKey: randomUUID(),
          status: "completed",
          request: { value: "Synthetic effect" },
          result: { preserved: true },
        },
      });
      const memory = await db.prisma.memoryDocument.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          botId: ordinary.id,
          scope: "bot",
          path: "private.md",
          content: "Synthetic private memory",
        },
      });
      const revision = await db.prisma.memoryRevision.create({
        data: {
          documentId: memory.id,
          revision: 1,
          content: memory.content,
          sourceThreadId: thread.id,
        },
      });
      const shared = await db.prisma.memoryDocument.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          scope: "user",
          path: "shared.md",
          content: "Synthetic shared memory",
        },
      });
      // Reconstruct an old mixed workspace only in this disposable test database.
      await admin.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("ALTER TABLE spaces DISABLE TRIGGER workspace_kind_change");
        await tx.space.update({
          where: { id: source.spaceId },
          data: { kind: "trading", isolationPending: true },
        });
        await tx.$executeRawUnsafe("ALTER TABLE spaces ENABLE TRIGGER workspace_kind_change");
      });
      const choice = {
        sourceSpaceId: source.spaceId,
        userId: uid,
        botIds: [ordinary.id],
        targetSpaceId: randomUUID(),
        targetName: "Synthetic general",
      };
      const preflight = await preflightWorkspaceMigration(db.prisma, choice);
      expect(preflight.blockers).toEqual([]);
      const ambiguous = await db.prisma.scratchpadItem.create({
        data: {
          spaceId: source.spaceId,
          userId: uid,
          botId: ordinary.id,
          title: "Unclassified synthetic note",
        },
      });
      expect((await preflightWorkspaceMigration(db.prisma, choice)).blockers).toContain(
        "Files, imports, taught skills or scratchpad ownership needs a separate reviewed plan",
      );
      await expect(
        migrateWorkspaceOwnership(db.prisma, choice, preflight.fingerprint),
      ).rejects.toThrow("Preflight changed");
      expect((await db.prisma.bot.findUnique({ where: { id: ordinary.id } }))?.spaceId).toBe(
        source.spaceId,
      );
      await db.prisma.scratchpadItem.delete({ where: { id: ambiguous.id } });

      await expect(migrateWorkspaceOwnership(db.prisma, choice, "stale")).rejects.toThrow(
        "Preflight changed",
      );
      await migrateWorkspaceOwnership(db.prisma, choice, preflight.fingerprint);
      expect(await db.prisma.thread.findUnique({ where: { id: thread.id } })).toMatchObject({
        spaceId: choice.targetSpaceId,
        historyCompactionSummary: "Synthetic summary",
      });
      expect((await db.prisma.message.findUnique({ where: { id: message.id } }))?.blocks).toEqual(
        message.blocks,
      );
      expect((await db.prisma.event.findUnique({ where: { id: event.id } }))?.payload).toEqual(
        event.payload,
      );
      expect(await db.prisma.run.findUnique({ where: { id: run.id } })).toMatchObject({
        spaceId: choice.targetSpaceId,
        taskId: task.id,
        threadId: thread.id,
      });
      expect(await db.prisma.externalEffect.findUnique({ where: { id: effect.id } })).toMatchObject(
        {
          spaceId: choice.targetSpaceId,
          runId: run.id,
          request: effect.request,
          result: effect.result,
        },
      );
      expect(await db.prisma.memoryDocument.findUnique({ where: { id: memory.id } })).toMatchObject(
        { spaceId: choice.targetSpaceId, content: memory.content },
      );
      expect(
        await db.prisma.memoryRevision.findUnique({ where: { id: revision.id } }),
      ).toMatchObject({ content: revision.content, sourceThreadId: thread.id });
      expect(await db.prisma.memoryDocument.findUnique({ where: { id: shared.id } })).toMatchObject(
        { spaceId: source.spaceId, content: shared.content },
      );
      expect(await db.prisma.space.findUnique({ where: { id: source.spaceId } })).toMatchObject({
        kind: "trading",
        isolationPending: false,
      });
      expect(
        await db.prisma.bot.findUnique({ where: { id: ordinary.id }, include: { computer: true } }),
      ).toMatchObject({
        spaceId: choice.targetSpaceId,
        computer: { spaceId: choice.targetSpaceId, homeRevision: "empty" },
      });
      expect(
        await db.prisma.auditEvent.count({
          where: { action: "workspace.ownership_migrated", targetId: choice.targetSpaceId },
        }),
      ).toBe(1);
    }));
});

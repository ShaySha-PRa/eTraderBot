import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../../../packages/adapters/src/executor-deps.js";
import { addMcpServerFromTool } from "../../../packages/adapters/src/mcp-server-tool.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const names = ["08 基线分配", "08 合成只读样例"] as const;
const secret = "synthetic-mcp-slug-credential";
const config = (name: string, slug = deriveMcpSlug(name)) => ({
  name,
  slug,
  transport: "streamable_http" as const,
  endpoint: "https://synthetic.example.test/mcp",
  headers: {},
  enabled: false,
  secret,
});

describe.skipIf(!enabled).sequential("MCP Unicode creation (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const secrets = new EncryptedSecretStore("synthetic-mcp-slug-encryption-key");
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = withSecretPersistence(db.prisma, secrets);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.pool.end();
    await secrets.close();
  });

  async function fixture() {
    const actor: Actor = {
      userId: randomUUID(),
      spaceId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      isDeploymentOwner: false,
    };
    const run = await runAsSystem("isolated MCP slug fixture", async () => {
      const organizationId = randomUUID();
      await prisma.user.create({
        data: { id: actor.userId, name: "Synthetic", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: actor.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: {
          id: actor.spaceId,
          organizationId,
          name: "Synthetic",
          kind: "general",
          createdByUserId: actor.userId,
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      const bot = await prisma.bot.create({
        data: { ...scope(actor), name: "Synthetic Bot", color: "blue" },
      });
      const thread = await prisma.thread.create({ data: { ...scope(actor), botId: bot.id } });
      const task = await prisma.task.create({
        data: {
          ...scope(actor),
          botId: bot.id,
          threadId: thread.id,
          status: "running",
          prompt: "Synthetic MCP registration",
        },
      });
      return prisma.run.create({
        data: {
          ...scope(actor),
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "message",
        },
      });
    });
    const events = { notify: vi.fn(async () => {}) };
    const rpc = createRouterClient(
      createRouter({
        prisma,
        secrets,
        events,
        remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        env: { webOrigin: "http://127.0.0.1:5667", defaultProvider: "fake", defaultModel: "fake" },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    const tool = (name: string) =>
      addMcpServerFromTool(
        {
          prisma,
          secretStore: secrets,
          events,
          secretHttp: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        } as unknown as ExecutorDeps,
        run,
        run.botId,
        config(name),
        randomUUID(),
      );
    return { actor, run, rpc, tool, tenant: <T>(fn: () => Promise<T>) => runAsTenant(actor, fn) };
  }
  function scope(actor: Actor) {
    return { spaceId: actor.spaceId, userId: actor.userId };
  }

  it("creates distinct Chinese connections through settings RPC without rewriting legacy slugs, grants or history", async () => {
    const f = await fixture();
    await f.tenant(async () => {
      const legacy = await f.rpc.mcp.servers.create(config(names[0], "08"));
      await f.rpc.mcp.servers.agents({ id: legacy.id, allBots: false, botIds: [f.run.botId] });
      const attempt = await prisma.attempt.create({
        data: { runId: f.run.id, fence: 0, status: "completed" },
      });
      const history = await prisma.runToolCall.create({
        data: {
          ...scope(f.actor),
          runId: f.run.id,
          attemptId: attempt.id,
          executionId: "synthetic-history",
          name: "mcp__08__read_synthetic_load",
          status: "completed",
        },
      });
      const before = await prisma.mcpServer.findUniqueOrThrow({
        where: { id: legacy.id },
        include: { assignments: true, secret: true },
      });
      const added = await f.rpc.mcp.servers.create(config(names[1]));
      expect(added.slug).toBe(deriveMcpSlug(names[1]));
      expect(added.slug).not.toBe("08");
      expect(added.enabled).toBe(false);
      expect(JSON.stringify(added)).not.toContain(secret);
      // A newly added connection remains disabled until the usual Bot selection and enable steps.
      await f.rpc.mcp.servers.agents({ id: added.id, allBots: false, botIds: [f.run.botId] });
      const updated = await f.rpc.mcp.servers.update({
        id: added.id,
        config: { ...config("新的显示名称", added.slug), enabled: true, secret: undefined },
      });
      expect(updated.slug).toBe(added.slug);
      expect(updated.hasSecret).toBe(true);
      expect(
        await prisma.mcpServer.findUniqueOrThrow({
          where: { id: legacy.id },
          include: { assignments: true, secret: true },
        }),
      ).toEqual(before);
      expect(await prisma.runToolCall.findUniqueOrThrow({ where: { id: history.id } })).toEqual(
        history,
      );
      // Explicit old identifiers still conflict even when the display name differs.
      await expect(f.rpc.mcp.servers.create(config("完全不同的名称", "08"))).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("identifier"),
      });
      expect(await prisma.mcpServer.count({ where: scope(f.actor) })).toBe(2);
      expect(await prisma.secret.count({ where: scope(f.actor) })).toBe(2);
    });
  });

  it("creates both Chinese names through the Bot tool and still requires separate approval", async () => {
    const f = await fixture();
    await f.tenant(async () => {
      for (const name of names) expect(await f.tool(name)).toMatchObject({ ok: true });
      const servers = await prisma.mcpServer.findMany({
        where: scope(f.actor),
        orderBy: { slug: "asc" },
      });
      expect(servers.map((s) => s.slug).sort()).toEqual(names.map(deriveMcpSlug).sort());
      expect(servers.every((s) => !s.allBots && !s.allSpaces)).toBe(true);
      expect(await prisma.botMcpServer.count({ where: { botId: f.run.botId } })).toBe(0);
      const messages = await prisma.message.findMany({
        where: { threadId: f.run.threadId },
        orderBy: { seq: "asc" },
      });
      expect(messages).toHaveLength(2);
      for (const [index, message] of messages.entries())
        expect(message.blocks).toEqual([
          expect.objectContaining({ kind: "mcp_approval", name: names[index], status: "pending" }),
        ]);
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(await f.tool(names[0])).toEqual({
        error:
          "An MCP server with this identifier already exists. Choose another name or use the existing connection.",
      });
      expect(await prisma.mcpServer.count({ where: scope(f.actor) })).toBe(2);
      expect(await prisma.secret.count({ where: scope(f.actor) })).toBe(2);
      expect(
        await prisma.message.findMany({
          where: { threadId: f.run.threadId },
          orderBy: { seq: "asc" },
        }),
      ).toEqual(messages);
    });
  });

  it("keeps database uniqueness for overlapping page and Bot creates of the same Unicode name", async () => {
    const f = await fixture();
    await f.tenant(async () => {
      const [page, bot] = await Promise.allSettled([
        f.rpc.mcp.servers.create(config(names[1])),
        f.tool(names[1]),
      ]);
      expect(bot.status).toBe("fulfilled");
      if (bot.status !== "fulfilled") throw bot.reason;
      if (page.status === "fulfilled") expect(bot.value).toHaveProperty("error");
      else {
        expect(page.reason).toMatchObject({ code: "CONFLICT" });
        expect(bot.value).toMatchObject({ ok: true });
      }
      expect(await prisma.mcpServer.count({ where: scope(f.actor) })).toBe(1);
      expect(await prisma.secret.count({ where: scope(f.actor) })).toBe(1);
      expect(await prisma.botMcpServer.count({ where: { botId: f.run.botId } })).toBe(0);
      expect(await prisma.message.count({ where: { threadId: f.run.threadId } })).toBe(
        page.status === "fulfilled" ? 0 : 1,
      );
    });
  });
});

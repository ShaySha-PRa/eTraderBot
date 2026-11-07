import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import type { Actor, McpServer, RpcOutput } from "@rakazo/contracts";
import {
  createBusinessCycleService,
  createRepos,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  startReadonlySourceExample,
  startSyntheticLoadSource,
} from "../../adapters/src/examples/readonly-source.js";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5663";

async function fixture(runtime: AgentRuntime) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-readonly-example-"));
  const { createApp } = await import("@rakazo/api/app");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    dataDir: dir,
    authUrl: origin,
    webOrigin: origin,
    sandboxProvider: "fake",
    modelConnectionFetch: createModelConnectionFixtureFetch([
      { provider: "openrouter", id: "scripted" },
    ]),
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    runtime,
  });
  const close = async () => {
    await handles.stop();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const email = `${randomUUID()}@example.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "password12", name: "Synthetic readonly" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const db = asSystem(handles.prisma);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const membership = await db.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
    let actor: Actor = {
      userId: user.id,
      email,
      spaceId: membership.spaceId,
      isDeploymentOwner: false,
    };
    const workspace = await runAsSystem("create isolated readonly fixture", () =>
      createTradingWorkspaceService(handles.prisma).createBusinessScope(actor, {
        name: "Synthetic readonly business",
        scope: {
          subjectId: "synthetic",
          subjectKind: "generator",
          accountId: "synthetic",
          assetId: "synthetic",
          region: "CN-SD",
          marketId: "synthetic",
          productId: "energy",
          environment: "simulation",
        },
        algorithmApproverUserId: user.id,
        tradeApproverUserId: user.id,
      }),
    );
    actor = { ...actor, spaceId: workspace.spaceId };
    const addBot = () =>
      runAsTenant(actor, () =>
        createRepos(handles.prisma).createBot(actor, {
          name: "Synthetic specialist",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          tradingRole: "risk",
          tradingWorkspaceId: workspace.id,
        }),
      );
    const bot = await addBot(); // Seed without a creation-intro run competing for the runtime.
    const cycle = await runAsTenant(actor, () =>
      createBusinessCycleService(handles.prisma).createDemo(actor, randomUUID()),
    );
    const response = (proc: string, input: unknown, spaceId = actor.spaceId) =>
      handles.app.request(`/rpc/${proc}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "x-rakazo-space-id": spaceId,
        },
        body: JSON.stringify({ json: input }),
      });
    async function rpc<T>(proc: string, input: unknown): Promise<T> {
      const res = await response(proc, input);
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body.json as T;
    }
    await rpc("models/connect", {
      provider: "openrouter",
      modelId: "scripted",
      apiKey: "synthetic-runtime-key",
    });
    return { ...handles, actor, workspace, db, bot, cycle, addBot, rpc, response, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const credential = "synthetic-readonly-isolated-token";
const query = { date: "2026-11-08", version: "synthetic-load-v1" };

function heldRuntime() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: unknown[] = [];
  let request: AgentRunRequest | undefined;
  const scripted = new ScriptedAgentRuntime();
  const runtime: AgentRuntime = {
    describe: () => ({
      ...scripted.describe(),
      capabilities: { ...scripted.describe().capabilities, scripted: false },
    }),
    abort: (id) => scripted.abort(id),
    async *run(value) {
      request = value;
      await ready;
      try {
        delivered.push(
          await value.executeTool!(
            "mcp__readonly-example__read_synthetic_load",
            query,
            "synthetic-read",
          ),
        );
      } catch (error) {
        delivered.push({ error: error instanceof Error ? error.message : String(error) });
      }
      yield { type: "done", text: "Synthetic readonly check ended" };
    },
  };
  return { runtime, release: () => release(), delivered, request: () => request };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await startSyntheticLoadSource({ workspaceId: f.actor.spaceId, credential });
  let sourceClosed = false;
  const stopSource = async () => {
    if (!sourceClosed) {
      sourceClosed = true;
      await source.close();
    }
  };
  const bridge = await startReadonlySourceExample({
    workspaceId: f.actor.spaceId,
    credential,
    sourceUrl: source.url,
  });
  const config = {
    transport: "streamable_http" as const,
    slug: "readonly-example",
    name: "Synthetic readonly example",
    endpoint: bridge.endpoint,
    headers: {},
    enabled: false,
  };
  try {
    const server = await f.rpc<McpServer>("mcp/servers/create", { ...config, secret: credential });
    await f.rpc("mcp/servers/agents", { id: server.id, allBots: false, botIds: [f.bot.id] });
    await f.rpc("mcp/servers/update", { id: server.id, config: { ...config, enabled: true } });
    await f.rpc("mcp/assignments/replace", {
      botId: f.bot.id,
      assignments: [
        { serverId: server.id, allowAllTools: false, allowedTools: ["read_synthetic_load"] },
      ],
    });
    return {
      server,
      config,
      stopSource,
      close: async () => {
        await bridge.close();
        await stopSource();
      },
    };
  } catch (error) {
    await bridge.close();
    await stopSource();
    throw error;
  }
}

describe
  .skipIf(!enabled)
  .sequential("08 readonly tool example through authenticated HTTP and real MCP", () => {
    it("configures an encrypted connection, grants one Bot a read, and retains source information without business writes", async () => {
      const held = heldRuntime();
      const f = await fixture(held.runtime);
      const connected = await connect(f);
      try {
        const listed = await f.rpc<RpcOutput<"mcp/servers/list">>("mcp/servers/list", undefined);
        expect(listed).toEqual([
          expect.objectContaining({ id: connected.server.id, allBots: false, enabled: true }),
        ]);
        expect(JSON.stringify(listed)).not.toContain(credential);
        const stored = await f.db.mcpServer.findUniqueOrThrow({
          where: { id: connected.server.id },
        });
        const secret = await f.db.secret.findUniqueOrThrow({ where: { id: stored.secretId! } });
        expect(secret.ciphertext).not.toContain(credential);
        const before = await f.db.businessEvidence.findMany({
          where: { cycleId: f.cycle.cycle.id },
          orderBy: { id: "asc" },
        });
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Query the synthetic load example for 2026-11-08",
        });
        await expect.poll(() => Boolean(held.request()), { timeout: 15000 }).toBe(true);
        expect(held.request()!.tools).toContainEqual(
          expect.objectContaining({
            name: "mcp__readonly-example__read_synthetic_load",
            readOnly: true,
          }),
        );
        expect(JSON.stringify(held.request()!.tools)).not.toContain(credential);
        held.release();
        await f.awaitIdle!();
        expect(held.delivered).toEqual([
          expect.objectContaining({
            isError: false,
            structuredContent: expect.objectContaining({
              ok: true,
              candidateOnly: true,
              date: "2026-11-08",
              source: expect.objectContaining({
                workspaceId: f.actor.spaceId,
                kind: "synthetic",
                version: "synthetic-load-v1",
              }),
              periods: [
                expect.objectContaining({ forecastMWh: 12.5 }),
                expect.objectContaining({ forecastMWh: 13.5 }),
              ],
            }),
          }),
        ]);
        expect(
          await f.db.businessEvidence.findMany({
            where: { cycleId: f.cycle.cycle.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(before);
        expect(await f.db.runToolCall.findMany({ where: { runId: sent.runId } })).toEqual([
          expect.objectContaining({ status: "completed" }),
        ]);
        const trace = await f.rpc<RpcOutput<"runs/detail">>("runs/detail", { runId: sent.runId });
        expect(trace.ticket).toBeNull(); // Ordinary chat, no ticket linkage required.
        expect(trace.toolTrace).toMatchObject({
          recorded: true,
          calls: [
            {
              status: "completed",
              resultSummary: {
                kind: "readonly_source",
                schemaVersion: 1,
                outcome: "success",
                candidateOnly: true,
                date: "2026-11-08",
                source: {
                  kind: "synthetic",
                  workspaceId: f.actor.spaceId,
                  version: "synthetic-load-v1",
                },
                periods: [
                  expect.objectContaining({ forecastMWh: 12.5 }),
                  expect.objectContaining({ forecastMWh: 13.5 }),
                ],
              },
            },
          ],
        });
        expect(JSON.stringify(trace)).not.toContain(credential);
        const persistedCall = await f.db.runToolCall.findFirstOrThrow({
          where: { runId: sent.runId },
        });
        expect(persistedCall.resultSummary).toEqual(trace.toolTrace.calls[0]!.resultSummary);
        // A new HTTP read must return the stored facts, independently of the runtime response.
        held.delivered.length = 0;
        expect(
          (await f.rpc<RpcOutput<"runs/detail">>("runs/detail", { runId: sent.runId })).toolTrace,
        ).toEqual(trace.toolTrace);
        const messages = await f.db.message.findMany({ where: { runId: sent.runId } });
        expect(JSON.stringify(messages)).not.toContain(credential);
        expect((await f.db.bot.findUniqueOrThrow({ where: { id: f.bot.id } })).tradingRole).toBe(
          "risk",
        );
        expect(await f.db.tradingGrant.count({ where: { botId: f.bot.id } })).toBe(0);
      } finally {
        held.release();
        await f.close();
        await connected.close();
      }
    });

    it("records a failed tool result when the source goes offline, without candidate evidence or credential leakage", async () => {
      const held = heldRuntime();
      const f = await fixture(held.runtime);
      const connected = await connect(f);
      try {
        const before = await f.db.businessEvidence.findMany({
          where: { cycleId: f.cycle.cycle.id },
          orderBy: { id: "asc" },
        });
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Read the synthetic forecast",
        });
        await expect.poll(() => Boolean(held.request()), { timeout: 15000 }).toBe(true);
        await connected.stopSource();
        held.release();
        await f.awaitIdle!();
        expect(held.delivered).toEqual([
          expect.objectContaining({
            isError: true,
            structuredContent: {
              ok: false,
              error: {
                code: "SOURCE_UNREACHABLE",
                message: "Synthetic source could not be reached",
                retryable: true,
              },
            },
          }),
        ]);
        expect(await f.db.runToolCall.findMany({ where: { runId: sent.runId } })).toEqual([
          expect.objectContaining({ status: "failed" }),
        ]);
        const trace = await f.rpc<RpcOutput<"runs/detail">>("runs/detail", { runId: sent.runId });
        expect(trace.toolTrace.calls).toEqual([
          expect.objectContaining({
            status: "failed",
            resultSummary: {
              kind: "readonly_source",
              schemaVersion: 1,
              outcome: "error",
              workspaceId: f.actor.spaceId,
              errorCode: "SOURCE_UNREACHABLE",
              retryable: true,
            },
          }),
        ]);
        expect(JSON.stringify(trace)).not.toContain("Synthetic source could not be reached");
        expect(JSON.stringify(trace)).not.toContain(credential);
        expect(
          await f.db.businessEvidence.findMany({
            where: { cycleId: f.cycle.cycle.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(before);
        expect(JSON.stringify(held.delivered)).not.toContain(credential);
      } finally {
        held.release();
        await f.close();
        await connected.close();
      }
    });

    it.each([
      "assignment_removed",
      "tool_removed",
      "source_disabled",
      "membership_removed",
      "bot_archived",
    ] as const)(
      "refuses a cached running Bot after %s, preserving business evidence",
      async (change) => {
        const held = heldRuntime();
        const f = await fixture(held.runtime);
        const connected = await connect(f);
        try {
          const sent = await f.rpc<{ runId: string }>("threads/send", {
            botId: f.bot.id,
            text: "Read the synthetic sample after my configuration check",
          });
          await expect.poll(() => Boolean(held.request()), { timeout: 15000 }).toBe(true);
          expect(held.request()!.tools).toContainEqual(
            expect.objectContaining({ name: "mcp__readonly-example__read_synthetic_load" }),
          );
          const evidence = await f.db.businessEvidence.findMany({
            where: { cycleId: f.cycle.cycle.id },
            orderBy: { id: "asc" },
          });
          if (change === "assignment_removed")
            await f.rpc("mcp/servers/agents", {
              id: connected.server.id,
              allBots: false,
              botIds: [],
            });
          if (change === "tool_removed")
            await f.rpc("mcp/assignments/replace", {
              botId: f.bot.id,
              assignments: [
                { serverId: connected.server.id, allowAllTools: false, allowedTools: [] },
              ],
            });
          if (change === "source_disabled")
            await f.rpc("mcp/servers/update", {
              id: connected.server.id,
              config: connected.config,
            });
          // Keep the actual Run alive to test a cached context, not archive cancellation.
          if (change === "membership_removed")
            await f.db.spaceMember.delete({
              where: { spaceId_userId: { spaceId: f.actor.spaceId, userId: f.actor.userId } },
            });
          if (change === "bot_archived")
            await f.db.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } });
          held.release();
          await f.awaitIdle!();
          expect(held.delivered).toHaveLength(1);
          expect(held.delivered[0]).toHaveProperty("error");
          expect(held.delivered[0]).not.toHaveProperty("structuredContent");
          expect(JSON.stringify(held.delivered)).not.toContain(credential);
          const calls = await f.db.runToolCall.findMany({ where: { runId: sent.runId } });
          expect(calls).toHaveLength(1);
          expect(calls[0]!.status).toBe("refused");
          expect(calls[0]!.resultSummary).toBeNull();
          if (change === "membership_removed") {
            expect((await f.response("runs/detail", { runId: sent.runId })).status).toBe(401);
          } else {
            const trace = await f.rpc<RpcOutput<"runs/detail">>("runs/detail", {
              runId: sent.runId,
            });
            expect(trace.toolTrace.calls).toEqual([
              expect.objectContaining({ status: "refused", resultSummary: null }),
            ]);
          }
          expect(
            await f.db.businessEvidence.findMany({
              where: { cycleId: f.cycle.cycle.id },
              orderBy: { id: "asc" },
            }),
          ).toEqual(evidence);
        } finally {
          held.release();
          await f.close();
          await connected.close();
        }
      },
    );

    it("rejects another business and an unassigned Bot even with a known source route", async () => {
      const f = await fixture(new ScriptedAgentRuntime());
      const connected = await connect(f);
      try {
        const unassigned = await f.addBot();
        const other = await runAsSystem("seed a second isolated readonly business", () =>
          createTradingWorkspaceService(f.prisma).createBusinessScope(f.actor, {
            name: "Other synthetic readonly business",
            scope: f.workspace.scope,
            algorithmApproverUserId: f.actor.userId,
            tradeApproverUserId: f.actor.userId,
          }),
        );
        const otherActor = { ...f.actor, spaceId: other.spaceId };
        const otherBot = await runAsTenant(otherActor, () =>
          createRepos(f.prisma).createBot(otherActor, {
            name: "Other specialist",
            description: "",
            instructions: "",
            notifyOnFinish: false,
            tradingRole: "risk",
            tradingWorkspaceId: other.id,
          }),
        );
        const listed = await f.response("mcp/servers/list", undefined, other.spaceId);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ json: [] });
        const assignForeign = await f.response("mcp/servers/agents", {
          id: connected.server.id,
          allBots: false,
          botIds: [otherBot.id],
        });
        expect(assignForeign.status).toBeGreaterThanOrEqual(400);
        expect(assignForeign.status).toBeLessThan(500);
        const updateForeign = await f.response(
          "mcp/servers/update",
          { id: connected.server.id, config: connected.config },
          other.spaceId,
        );
        expect(updateForeign.status).toBeGreaterThanOrEqual(400);
        expect(updateForeign.status).toBeLessThan(500);
        for (const [actor, botId] of [
          [f.actor, unassigned.id],
          [otherActor, otherBot.id],
        ] as const) {
          const result = await runAsTenant(actor, async () => {
            const events = [];
            for await (const event of f.connectors.execute(
              {
                tool: "mcp__readonly-example__read_synthetic_load",
                args: query,
                executionId: randomUUID(),
                route: {
                  connectorId: "mcp",
                  resourceId: connected.server.id,
                  toolName: "read_synthetic_load",
                },
              },
              {
                ...actor,
                botId,
                operationId: randomUUID(),
                traceId: randomUUID(),
                signal: new AbortController().signal,
              },
            ))
              events.push(event);
            return events;
          });
          expect(result).toEqual([expect.objectContaining({ type: "error" })]);
          expect(JSON.stringify(result)).not.toContain(credential);
        }
        const after = await f.rpc<RpcOutput<"mcp/servers/list">>("mcp/servers/list", undefined);
        expect(after[0]).toMatchObject({ id: connected.server.id, enabled: true, allBots: false });
      } finally {
        await f.close();
        await connected.close();
      }
    });
  });

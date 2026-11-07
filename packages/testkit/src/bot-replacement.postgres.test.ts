import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, ScriptedAgentRuntime } from "@rakazo/adapters";
import type {
  Actor,
  BoardEvent,
  BusinessCycleState,
  BusinessWorkResult,
  RpcOutput,
  TradingBotRole,
} from "@rakazo/contracts";
import { currentBusinessEvidence } from "@rakazo/core";
import {
  boardEventTopic,
  createBusinessCycleService,
  createPool,
  createRepos,
  createTradingControlService,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { InMemoryRealtimeFanout } from "../../adapters/src/realtime.js";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5661";

async function fixture(runtime: AgentRuntime) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-bot-replacement-"));
  const { createApp } = await import("@rakazo/api/app");
  const realtime = new InMemoryRealtimeFanout();
  const handles = await createApp({
    realtime,
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
      body: JSON.stringify({ email, password: "password12", name: "Synthetic replacement" }),
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
    const workspace = await runAsSystem("create isolated replacement fixture", () =>
      createTradingWorkspaceService(handles.prisma).createBusinessScope(actor, {
        name: "Synthetic replacement business",
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
    const addBot = (role: TradingBotRole = "mid_long_term") =>
      runAsTenant(actor, () =>
        createRepos(handles.prisma).createBot(actor, {
          name: "Synthetic specialist",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          tradingRole: role,
          tradingWorkspaceId: workspace.id,
        }),
      );
    const bot = await addBot(); // Seed without a creation-intro run competing for the runtime.
    const cycle = await runAsTenant(actor, () =>
      createBusinessCycleService(handles.prisma).createDemo(actor, randomUUID()),
    );
    const response = (proc: string, input: unknown) =>
      handles.app.request(`/rpc/${proc}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "x-rakazo-space-id": actor.spaceId,
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
    const events: BoardEvent[] = [];
    const unsubscribe = await realtime.subscribe(boardEventTopic(actor.spaceId), (payload) => {
      events.push(JSON.parse(payload) as BoardEvent);
    });
    return {
      ...handles,
      actor,
      workspace,
      db,
      bot,
      cycle,
      addBot,
      rpc,
      response,
      events,
      close: async () => {
        await unsubscribe();
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function contractResult(state: BusinessCycleState): BusinessWorkResult {
  return {
    evidenceIds: currentBusinessEvidence(state.evidence)
      .filter((e) => e.streamKey === "contracts")
      .map((e) => e.id),
    summary: "Synthetic unfinished coverage",
    disagreements: ["Synthetic contract disagreement"],
    unresolved: ["Confirm the financial contract interpretation"],
    improvementProposal: null,
  };
}

describe.skipIf(!enabled).sequential("06 Bot replacement through authenticated HTTP", () => {
  it("archiving from the Bot endpoint blocks unfinished work, notifies the board and preserves prior results", async () => {
    const f = await fixture(new ScriptedAgentRuntime());
    try {
      const state = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId: f.cycle.cycle.id,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      const ticketId = state.tasks[0]!.ticketId;
      await f.awaitIdle!();
      const result: BusinessWorkResult = {
        evidenceIds: currentBusinessEvidence(state.evidence)
          .filter((e) => e.streamKey === "contracts")
          .map((e) => e.id),
        summary: "Synthetic unfinished assessment",
        disagreements: ["Contract explanation differs"],
        unresolved: ["Confirm financial versus physical coverage"],
        improvementProposal: null,
      };
      await f.rpc<BusinessCycleState>("businessCycle/complete", {
        ticketId,
        result,
      });
      const withHistory = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId: state.cycle.id,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      const completedTicketId = withHistory.tasks.find(
        (task) => task.ticketId !== ticketId,
      )!.ticketId;
      await f.awaitIdle!();
      const completedResult = { ...result, disagreements: [], unresolved: [] };
      const before = await f.rpc<BusinessCycleState>("businessCycle/complete", {
        ticketId: completedTicketId,
        result: completedResult,
      });
      const comments = await f.db.ticketComment.findMany({
        where: { ticketId },
        orderBy: { id: "asc" },
      });
      const runs = await f.db.run.count({
        where: { task: { ticketId: { in: [ticketId, completedTicketId] } } },
      });
      f.events.length = 0;
      await f.rpc("bots/archive", { botId: f.bot.id });
      const after = await f.rpc<BusinessCycleState>("businessCycle/get", {
        cycleId: state.cycle.id,
      });
      expect(after.tasks[0]).toMatchObject({
        ticketId,
        status: "blocked",
        result,
        resultEvidenceId: before.tasks[0]!.resultEvidenceId,
      });
      expect(after.tasks[0]!.startBlockers).toContain("assignee:archived");
      expect(after.tasks.find((task) => task.ticketId === completedTicketId)).toMatchObject({
        status: "done",
        assigneeBotId: f.bot.id,
        result: completedResult,
        resultEvidenceId: before.tasks.find((task) => task.ticketId === completedTicketId)!
          .resultEvidenceId,
        blockers: [],
        startBlockers: [],
      });
      expect(after.evidence).toEqual(before.evidence);
      expect(f.events).toContainEqual(
        expect.objectContaining({ ticketId, spaceId: f.actor.spaceId }),
      );
      expect(
        await f.db.run.count({
          where: { task: { ticketId: { in: [ticketId, completedTicketId] } } },
        }),
      ).toBe(runs);
      expect(
        await f.db.ticketComment.findMany({ where: { ticketId }, orderBy: { id: "asc" } }),
      ).toEqual(comments);
    } finally {
      await f.close();
    }
  });
  it("offers only live same-business specialists, rejects invalid replacements and keeps identical retries idempotent", async () => {
    const f = await fixture(new ScriptedAgentRuntime());
    const foreign = await fixture(new ScriptedAgentRuntime());
    try {
      const state = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId: f.cycle.cycle.id,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      const ticketId = state.tasks[0]!.ticketId;
      await f.awaitIdle!();
      const target = await f.addBot(),
        wrong = await f.addBot("risk"),
        archived = await f.addBot();
      await f.rpc("bots/archive", { botId: archived.id });
      const supervisor = await f.db.bot.findFirstOrThrow({
        where: { spaceId: f.actor.spaceId, businessSupervisor: true },
      });
      expect(await f.rpc("businessCycle/recovery", { ticketId })).toMatchObject({
        canReplace: false,
        candidates: [],
        assignee: { id: f.bot.id, archivedAt: null },
      });
      expect(
        (await f.response("tickets/update", { id: ticketId, assigneeBotId: target.id })).status,
      ).toBe(403);
      await f.rpc("bots/archive", { botId: f.bot.id });
      const recovery = await f.rpc<RpcOutput<"businessCycle/recovery">>("businessCycle/recovery", {
        ticketId,
      });
      expect(recovery).toMatchObject({
        ticketId,
        cycleId: state.cycle.id,
        requiredRole: "mid_long_term",
        canReplace: true,
        candidates: [{ id: target.id, name: target.name }],
        assignee: { id: f.bot.id, archivedAt: expect.any(String) },
      });
      const before = await f.rpc<BusinessCycleState>("businessCycle/get", {
        cycleId: state.cycle.id,
      });
      const otherSpace = await runAsSystem("same-user replacement boundary fixture", () =>
        createTradingWorkspaceService(f.prisma).createBusinessScope(f.actor, {
          name: "Other synthetic business",
          scope: f.workspace.scope,
          algorithmApproverUserId: f.actor.userId,
          tradeApproverUserId: f.actor.userId,
        }),
      );
      const otherActor = { ...f.actor, spaceId: otherSpace.spaceId };
      const otherBot = await runAsTenant(otherActor, () =>
        createRepos(f.prisma).createBot(otherActor, {
          name: "Other specialist",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          tradingRole: "mid_long_term",
          tradingWorkspaceId: otherSpace.id,
        }),
      );
      for (const invalid of [wrong.id, supervisor.id, archived.id, foreign.bot.id, otherBot.id]) {
        const res = await f.response("tickets/update", { id: ticketId, assigneeBotId: invalid });
        expect([403, 404]).toContain(res.status);
        expect(await f.rpc("businessCycle/get", { cycleId: state.cycle.id })).toEqual(before);
      }
      const foreignRead = await foreign.response("businessCycle/recovery", { ticketId });
      expect(foreignRead.status).toBe(404);
      // A previously listed candidate is not a lasting authorization.
      await f.rpc("bots/archive", { botId: target.id });
      expect(
        (await f.response("tickets/update", { id: ticketId, assigneeBotId: target.id })).status,
      ).toBe(404);
      await f.rpc("bots/restore", { botId: target.id });
      await Promise.all(
        Array.from({ length: 4 }, () =>
          f.rpc("tickets/update", { id: ticketId, assigneeBotId: target.id }),
        ),
      );
      await f.awaitIdle!();
      await f.rpc("tickets/update", { id: ticketId, assigneeBotId: target.id });
      const runs = await f.db.run.findMany({ where: { task: { ticketId } } });
      expect(runs).toHaveLength(2);
      expect(runs.filter((r) => r.botId === target.id)).toHaveLength(1);
      expect(await f.db.task.count({ where: { ticketId } })).toBe(2);
      expect(await f.rpc("businessCycle/recovery", { ticketId })).toMatchObject({
        canReplace: false,
        candidates: [],
        assignee: { id: target.id, archivedAt: null },
      });
      expect(
        (await f.rpc<BusinessCycleState>("businessCycle/get", { cycleId: state.cycle.id }))
          .evidence,
      ).toEqual(before.evidence);
      // Deletion still has explicit null semantics and preserves the original work.
      await f.db.bot.delete({ where: { id: target.id } });
      expect(await f.rpc("businessCycle/recovery", { ticketId })).toMatchObject({
        assignee: null,
        canReplace: true,
      });
    } finally {
      await f.close();
      await foreign.close();
    }
  });

  it("replaces a running Bot through the normal API and queue, reads prior findings, and refuses its late tool call", async () => {
    const initial = gate(),
      late = gate(),
      continuation = gate();
    let original = "",
      replacement = "",
      ticketId = "",
      cycleId = "";
    let first!: BusinessWorkResult;
    let originalRecorded = false,
      replacementStarted = false,
      lateRefused = false;
    let read!: BusinessCycleState;
    const outcomes: BusinessCycleState[] = [];
    const scripted = new ScriptedAgentRuntime();
    const runtime: AgentRuntime = {
      describe: () => ({
        ...scripted.describe(),
        capabilities: { ...scripted.describe().capabilities, scripted: false },
      }),
      abort: (id) => scripted.abort(id),
      async *run(request) {
        if (request.botId === original) {
          await initial.promise;
          await request.executeTool!(
            "business_cycle",
            { operation: "complete", ticketId, result: first },
            "old-findings",
          );
          originalRecorded = true;
          await late.promise;
          try {
            await request.executeTool!(
              "business_cycle",
              { operation: "complete", ticketId, result: { ...first, summary: "Late old result" } },
              "old-late-result",
            );
          } catch {
            lateRefused = true;
          }
        } else if (request.botId === replacement) {
          replacementStarted = true;
          await continuation.promise;
          expect(request.prompt).toContain(cycleId);
          read = (await request.executeTool!(
            "business_cycle",
            { operation: "read", cycleId },
            "new-read",
          )) as BusinessCycleState;
          const task = read.tasks.find((t) => t.ticketId === ticketId)!;
          expect(task.result).toEqual(first);
          const next = { ...contractResult(read), summary: "Synthetic replacement investigation" };
          outcomes.push(
            (await request.executeTool!(
              "business_cycle",
              {
                operation: "complete",
                ticketId,
                result: next,
                expectedResultEvidenceId: task.resultEvidenceId,
              },
              "new-investigation",
            )) as BusinessCycleState,
          );
          const head = outcomes[0]!.tasks.find((t) => t.ticketId === ticketId)!.resultEvidenceId;
          outcomes.push(
            (await request.executeTool!(
              "business_cycle",
              {
                operation: "complete",
                ticketId,
                result: { ...next, unresolved: [] },
                expectedResultEvidenceId: head,
              },
              "new-resolved",
            )) as BusinessCycleState,
          );
        }
        yield { type: "done", text: "Synthetic replacement plan finished" };
      },
    };
    const f = await fixture(runtime);
    try {
      original = f.bot.id;
      cycleId = f.cycle.cycle.id;
      first = contractResult(f.cycle);
      const assigned = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      ticketId = assigned.tasks[0]!.ticketId;
      initial.open();
      await expect.poll(() => originalRecorded, { timeout: 10000 }).toBe(true);
      const before = await f.rpc<BusinessCycleState>("businessCycle/get", { cycleId });
      const oldRun = await f.db.run.findFirstOrThrow({
        where: { task: { ticketId }, botId: original },
      });
      expect(oldRun.status).toBe("running");
      replacement = (await f.addBot()).id;
      await f.rpc("bots/archive", { botId: original });
      expect(await f.db.run.findUnique({ where: { id: oldRun.id } })).toMatchObject({
        status: "cancelled",
      });
      await Promise.all([
        f.rpc("tickets/update", { id: ticketId, assigneeBotId: replacement }),
        f.rpc("tickets/update", { id: ticketId, assigneeBotId: replacement }),
      ]);
      await expect.poll(() => replacementStarted, { timeout: 10000 }).toBe(true);
      late.open();
      await expect.poll(() => lateRefused, { timeout: 10000 }).toBe(true);
      // Restoring the old Bot does not make it the ticket's current owner again.
      await f.rpc("bots/restore", { botId: original });
      await expect(
        runAsTenant(f.actor, () =>
          createBusinessCycleService(f.prisma).complete(
            { ...f.actor, botId: original },
            ticketId,
            first,
            before.tasks[0]!.resultEvidenceId,
          ),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      continuation.open();
      await f.awaitIdle!();
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]!.tasks.find((t) => t.ticketId === ticketId)).toMatchObject({
        status: "review",
        result: { unresolved: first.unresolved },
      });
      const after = await f.rpc<BusinessCycleState>("businessCycle/get", { cycleId });
      expect(after.tasks[0]).toMatchObject({
        ticketId,
        assigneeBotId: replacement,
        status: "done",
      });
      expect(after.evidence).toEqual(expect.arrayContaining(before.evidence));
      const reviews = after.evidence.filter((e) => e.streamKey === `review:${ticketId}`);
      expect(reviews.map((e) => e.recordedByBotId)).toEqual([original, replacement, replacement]);
      expect(reviews[1]!.supersedesId).toBe(reviews[0]!.id);
      expect(reviews[2]!.supersedesId).toBe(reviews[1]!.id);
      expect(await f.db.run.count({ where: { task: { ticketId } } })).toBe(2);
      expect(await f.db.businessCycleWork.count({ where: { cycleId } })).toBe(1);
      expect(
        await f.db.runToolCall.findFirst({
          where: { runId: oldRun.id, executionId: "old-late-result" },
        }),
      ).toMatchObject({ status: "refused" });
    } finally {
      initial.open();
      late.open();
      continuation.open();
      await f.close();
    }
  });
  it.each(["identical", "different"] as const)(
    "serializes strictly overlapping %s replacement requests without duplicate executable work",
    async (mode) => {
      const f = await fixture(new ScriptedAgentRuntime());
      const owner = createPool(process.env.DATABASE_MIGRATION_URL!, { poolMax: 2 });
      const lock = await owner.connect();
      try {
        const assigned = await f.rpc<BusinessCycleState>("businessCycle/assign", {
          cycleId: f.cycle.cycle.id,
          kind: "contract_coverage",
          dependsOn: [],
          requestId: randomUUID(),
        });
        const ticketId = assigned.tasks[0]!.ticketId;
        await f.awaitIdle!();
        await f.rpc("bots/archive", { botId: f.bot.id });
        const a = await f.addBot(),
          b = mode === "identical" ? a : await f.addBot();
        await lock.query("BEGIN");
        await lock.query("SELECT id FROM business_cycles WHERE id=$1 FOR UPDATE", [
          f.cycle.cycle.id,
        ]);
        const {
          rows: [{ pid }],
        } = await lock.query("SELECT pg_backend_pid() AS pid");
        const sends = Promise.all(
          [a, b].map((bot) =>
            f.response("tickets/update", { id: ticketId, assigneeBotId: bot.id }),
          ),
        );
        try {
          await expect
            .poll(
              async () => {
                const result = await owner.query(
                  `WITH RECURSIVE waiting(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
            UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
          ) SELECT a.pid FROM waiting w JOIN pg_stat_activity a ON a.pid=w.pid WHERE a.wait_event_type='Lock'
          AND a.query LIKE '%SELECT id FROM business_cycles%FOR UPDATE%'`,
                  [pid],
                );
                return result.rows.length;
              },
              { timeout: 3000, interval: 20 },
            )
            .toBe(2);
        } finally {
          await lock.query("ROLLBACK");
        }
        const responses = await sends;
        expect(responses.map((r) => r.status).sort()).toEqual(
          mode === "identical" ? [200, 200] : [200, 403],
        );
        if (mode === "different")
          expect(await responses.find((r) => r.status === 403)!.json()).toMatchObject({
            json: { code: "FORBIDDEN", data: { reason: "FORBIDDEN" } },
          });
        await f.awaitIdle!();
        const runs = await f.db.run.findMany({ where: { task: { ticketId } } });
        expect(runs).toHaveLength(2);
        const current = await f.rpc<BusinessCycleState>("businessCycle/get", {
          cycleId: f.cycle.cycle.id,
        });
        expect(runs.filter((r) => r.botId === current.tasks[0]!.assigneeBotId)).toHaveLength(1);
        expect(current.evidence).toEqual(assigned.evidence);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
        await owner.end();
        await f.close();
      }
    },
  );

  it("keeps source credentials, algorithm decisions and Bot-bound grants separate from reassignment", async () => {
    const f = await fixture(new ScriptedAgentRuntime());
    try {
      const state = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId: f.cycle.cycle.id,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      const ticketId = state.tasks[0]!.ticketId;
      await f.awaitIdle!();
      const target = await f.addBot();
      const tenant = <T>(fn: () => Promise<T>) => runAsTenant(f.actor, fn);
      const control = createTradingControlService(f.prisma);
      const cycle = createBusinessCycleService(f.prisma);
      const desks = await tenant(() => control.desks(f.actor));
      const deskId = desks.find((d) => d.scope.stage === "mid_long_term")!.id;
      const analysis = await tenant(() =>
        cycle.analyze(f.actor, { cycleId: f.cycle.cycle.id, deskId, margin: "0" }),
      );
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      const oldIntent = await tenant(() =>
        control.prepareIntent(f.actor, { deskId, analysisId: analysis.id, expiresAt }, f.bot.id),
      );
      const newIntent = await tenant(() =>
        control.prepareIntent(f.actor, { deskId, analysisId: analysis.id, expiresAt }, target.id),
      );
      const version = (await tenant(() => control.desk(f.actor, { deskId }))).versions.find(
        (v) => v.id === oldIntent.versionId,
      )!;
      await tenant(() =>
        control.approveAlgorithm(f.actor, {
          deskId,
          versionId: version.id,
          expectedArtifactHash: version.artifactHash,
        }),
      );
      await tenant(() =>
        control.approveIntent(f.actor, {
          deskId,
          intentId: oldIntent.id,
          expectedIntentHash: oldIntent.intent.intentHash,
        }),
      );
      const grant = await tenant(() =>
        control.createGrant(f.actor, {
          deskId,
          versionId: version.id,
          botId: f.bot.id,
          perTradeLimitCny: "1000000",
          cumulativeLimitCny: "2000000",
          expiresAt,
        }),
      );
      const alternate = await tenant(() =>
        cycle.analyze(f.actor, { cycleId: f.cycle.cycle.id, deskId, margin: "1" }),
      );
      const pending = await tenant(() =>
        control.prepareIntent(f.actor, { deskId, analysisId: alternate.id, expiresAt }, target.id),
      );
      expect(pending.versionId).not.toBe(version.id);
      const stored = await new EncryptedSecretStore(process.env.ENCRYPTION_KEY!).put(
        "synthetic-private-credential",
        { ...f.actor, operationId: "test", traceId: "test", signal: new AbortController().signal },
      );
      await f.db.botSecret.create({
        data: {
          id: stored.id,
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          botId: f.bot.id,
          name: "source-only",
          origin: "https://example.test",
          auth: { type: "bearer" },
          ciphertext: stored.ciphertext,
        },
      });
      const protectedState = async () => ({
        secrets: await f.db.botSecret.findMany({
          where: { spaceId: f.actor.spaceId },
          orderBy: { id: "asc" },
        }),
        grants: await f.db.tradingGrant.findMany({ where: { deskId }, orderBy: { id: "asc" } }),
        intents: await f.db.tradingIntent.findMany({ where: { deskId }, orderBy: { id: "asc" } }),
        versions: await f.db.tradingVersion.findMany({ where: { deskId }, orderBy: { id: "asc" } }),
        bindings: await f.db.tradingBotBinding.findMany({
          where: { deskId },
          orderBy: { botId: "asc" },
        }),
      });
      const before = await protectedState();
      await f.rpc("bots/archive", { botId: f.bot.id });
      await f.rpc("tickets/update", { id: ticketId, assigneeBotId: target.id });
      await f.awaitIdle!();
      expect(await protectedState()).toEqual(before);
      expect(await f.db.botSecret.count({ where: { botId: target.id } })).toBe(0);
      const request = (intent: typeof newIntent) => ({
        deskId,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
        clientRequestId: randomUUID(),
      });
      await expect(
        tenant(() => control.executeSimulation(f.actor, request(pending), target.id)),
      ).rejects.toMatchObject({ code: "ALGORITHM_NOT_APPROVED" });
      await expect(
        tenant(() => control.executeSimulation(f.actor, request(newIntent), target.id)),
      ).rejects.toMatchObject({ code: "TRADE_NOT_APPROVED" });
      await expect(
        tenant(() =>
          control.executeSimulation(
            f.actor,
            { ...request(newIntent), grantId: grant.id },
            target.id,
          ),
        ),
      ).rejects.toMatchObject({ code: "GRANT_MISMATCH" });
      await expect(
        tenant(() => control.executeSimulation(f.actor, request(oldIntent), target.id)),
      ).rejects.toMatchObject({ code: "BOT_MISMATCH" });
      expect(await f.db.tradingExecution.count({ where: { deskId } })).toBe(0);
      expect(await protectedState()).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it("keeps replacement work blocked until its prerequisite result exists, then dispatches the new Bot once", async () => {
    const f = await fixture(new ScriptedAgentRuntime());
    try {
      const cycleId = f.cycle.cycle.id;
      const prerequisite = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId,
        kind: "contract_coverage",
        dependsOn: [],
        requestId: randomUUID(),
      });
      const contractId = prerequisite.tasks[0]!.ticketId;
      await f.awaitIdle!();
      const oldSpot = await f.addBot("spot");
      const assigned = await f.rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId,
        kind: "spot_analysis",
        dependsOn: [contractId],
        requestId: randomUUID(),
      });
      const ticketId = assigned.tasks.find((t) => t.kind === "spot_analysis")!.ticketId;
      expect(assigned.tasks.find((t) => t.ticketId === ticketId)).toMatchObject({
        status: "blocked",
      });
      await f.rpc("bots/archive", { botId: oldSpot.id });
      const target = await f.addBot("spot");
      await f.rpc("tickets/update", { id: ticketId, assigneeBotId: target.id });
      await f.rpc("tickets/update", { id: ticketId, assigneeBotId: target.id });
      const blocked = await f.rpc<BusinessCycleState>("businessCycle/get", { cycleId });
      expect(blocked.tasks.find((t) => t.ticketId === ticketId)).toMatchObject({
        status: "blocked",
        assigneeBotId: target.id,
        startBlockers: [`task:${contractId}`],
      });
      expect(await f.db.run.count({ where: { task: { ticketId } } })).toBe(0);
      expect(blocked.evidence).toEqual(assigned.evidence);
      const result = { ...contractResult(blocked), unresolved: [] };
      await f.rpc("businessCycle/complete", { ticketId: contractId, result });
      await f.awaitIdle!();
      await f.rpc("businessCycle/complete", { ticketId: contractId, result });
      await f.awaitIdle!();
      const runs = await f.db.run.findMany({ where: { task: { ticketId } } });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.botId).toBe(target.id);
      expect(
        (await f.rpc<BusinessCycleState>("businessCycle/get", { cycleId })).tasks.find(
          (t) => t.ticketId === ticketId,
        ),
      ).toMatchObject({ status: "todo", startBlockers: [] });
    } finally {
      await f.close();
    }
  });
});

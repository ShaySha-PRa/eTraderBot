import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, BackgroundJob } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { createJobReconciler, ScriptedAgentRuntime } from "@rakazo/adapters";
import type {
  Actor,
  BusinessCycleState,
  BusinessWorkResult,
  RunTraceDetail,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { currentBusinessEvidence } from "@rakazo/core";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { Pool } from "@rakazo/db";
import {
  createBusinessCycleService,
  createPool,
  createRepos,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

// Fault injection needs the owner login to hold row locks and end the runtime's
// connection; both point at this file's own disposable database copy.
const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_MIGRATION_URL);
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5651";

type Plan = (
  request: Parameters<AgentRuntime["run"]>[0],
  context: Parameters<AgentRuntime["run"]>[1],
  attempt: number,
) => AsyncGenerator<{ type: "done"; text: string } | { type: "ask"; text: string }>;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function fixture() {
  const plans = new Map<string, Plan>();
  const attempts = new Map<string, number>();
  const scripted = new ScriptedAgentRuntime();
  const runtime: AgentRuntime = {
    describe: () => ({
      ...scripted.describe(),
      capabilities: { ...scripted.describe().capabilities, scripted: false },
    }),
    abort: (id) => scripted.abort(id),
    async *run(request, context) {
      const plan = plans.get(request.botId);
      if (!plan) {
        yield { type: "done", text: "No synthetic plan" };
        return;
      }
      const attempt = (attempts.get(request.runId) ?? 0) + 1;
      attempts.set(request.runId, attempt);
      yield* plan(request, context, attempt);
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-run-recovery-"));
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
  const owner = createPool(process.env.DATABASE_MIGRATION_URL!, { poolMax: 4 });
  const close = async () => {
    await handles.stop();
    await owner.end();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const email = `${randomUUID()}@example.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "password12", name: "Synthetic recovery" }),
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
    const workspace = await runAsSystem("create isolated run recovery fixture", () =>
      createTradingWorkspaceService(handles.prisma).createBusinessScope(actor, {
        name: "Synthetic recovery business",
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
    const addBot = (name: string, tradingRole: "mid_long_term" | "risk") =>
      runAsTenant(actor, () =>
        createRepos(handles.prisma).createBot(actor, {
          name,
          description: "",
          instructions: "",
          notifyOnFinish: false,
          tradingRole,
          tradingWorkspaceId: workspace.id,
        }),
      );
    const specialist = await addBot("Synthetic contracts specialist", "mid_long_term");
    const independent = await addBot("Synthetic independent risk", "risk");
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

    async function assign(kind: "contract_coverage" | "risk_check") {
      const state = await rpc<BusinessCycleState>("businessCycle/assign", {
        cycleId: cycle.cycle.id,
        kind,
        dependsOn: [],
        requestId: randomUUID(),
      });
      const task = state.tasks.find((t) => t.kind === kind)!;
      const result: BusinessWorkResult = {
        evidenceIds: currentBusinessEvidence(state.evidence)
          .filter((e) => e.streamKey === "contracts")
          .map((e) => e.id),
        summary: "Synthetic sourced contract result",
        disagreements: [],
        unresolved: [],
        improvementProposal: null,
      };
      return { ticketId: task.ticketId, result };
    }
    const runFor = async (ticketId: string) => {
      await expect
        .poll(() => db.run.count({ where: { task: { ticketId } } }), { timeout: 15000 })
        .toBe(1);
      return db.run.findFirstOrThrow({ where: { task: { ticketId } } });
    };
    const persisted = async (ticketId: string, runId: string) => ({
      evidence: await db.businessEvidence.count({
        where: { cycleId: cycle.cycle.id, streamKey: `review:${ticketId}` },
      }),
      comments: await db.ticketComment.count({ where: { ticketId } }),
      work: await db.businessCycleWork.findUniqueOrThrow({ where: { ticketId } }),
      ticket: await db.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
      effects: await db.externalEffect.findMany({
        where: { runId, kind: "business_cycle" },
        select: { idempotencyKey: true, status: true },
      }),
    });

    /** A dead process leaves its leases to expire; recovery only ever sees that row state. */
    async function expireLeases(runId: string) {
      await owner.query(
        `UPDATE runs SET "leaseExpiresAt" = now() - interval '1 second' WHERE id = $1`,
        [runId],
      );
      await owner.query(
        `UPDATE computer_execution_leases SET "expiresAt" = now() - interval '1 second' WHERE "runId" = $1`,
        [runId],
      );
    }
    /** What the elected reconciler would hand to a worker on any instance. */
    async function reconcilerPicks(): Promise<string[]> {
      const picked: string[] = [];
      const reconciler = createJobReconciler({
        prisma: handles.prisma,
        jobs: {
          async enqueue(job: BackgroundJob) {
            if (job.name === "run.continue") picked.push(job.payload.runId);
          },
          async cancel() {},
          async close() {},
        },
      });
      await runAsSystem("04 recovery reconciliation probe", () => reconciler.reconcileOnce());
      return picked;
    }
    /** Another instance's worker taking the recovered run, exactly as its run.continue job does. */
    const recover = async (runId: string, workerId: string) => {
      const tenant = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: { spaceId: true, userId: true },
      });
      await runAsTenant(tenant, () => handles.executor.continueRun(runId, workerId));
    };

    return {
      ...handles,
      owner,
      plans,
      attempts,
      actor,
      db,
      specialist,
      independent,
      cycle,
      rpc,
      response,
      assign,
      runFor,
      persisted,
      expireLeases,
      reconcilerPicks,
      recover,
      snapshot: (botId: string) => rpc<ThreadSnapshot>("threads/get", { botId }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Hold a row lock on the owner login until released, to stop the runtime at an exact point. */
async function holdRowLock(owner: Pool, sql: string, params: unknown[]) {
  const client = await owner.connect();
  await client.query("BEGIN");
  const locked = await client.query(sql, params);
  expect(locked.rowCount).toBe(1);
  return {
    release: async () => {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

/** The runtime login's backend that is blocked on a lock while running the given statement. */
async function blockedBackend(owner: Pool, pattern: string): Promise<number> {
  let pid: number | undefined;
  await expect
    .poll(
      async () => {
        const rows = await owner.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND usename = 'rakazo_app'
             AND wait_event_type = 'Lock' AND query ILIKE $1`,
          [pattern],
        );
        pid = rows.rows[0]?.pid;
        return rows.rows.length;
      },
      { timeout: 15000 },
    )
    .toBe(1);
  return pid!;
}

describe.skipIf(!enabled).sequential("04 run recovery after interruption", () => {
  it("09-D1 manager assigns through the real tool boundary with one persisted request and no authority transfer", async () => {
    const f = await fixture();
    try {
      const manager = await f.db.bot.findFirstOrThrow({
        where: { spaceId: f.actor.spaceId, businessSupervisor: true },
      });
      const requestId = randomUUID();
      const args = {
        operation: "assign",
        cycleId: f.cycle.cycle.id,
        requestId,
        kind: "contract_coverage",
      };
      const outputs: unknown[] = [];
      f.plans.set(manager.id, async function* (request) {
        outputs.push(await request.executeTool!("business_cycle", args, "assign-first"));
        outputs.push(await request.executeTool!("business_cycle", args, "assign-repeat"));
        outputs.push(
          await request.executeTool!(
            "business_cycle",
            { ...args, kind: "risk_check" },
            "assign-conflict",
          ),
        );
        yield { type: "done", text: "Synthetic assignment ended" };
      });
      const accepted = await f.rpc<{ runId: string }>("threads/send", {
        botId: manager.id,
        text: "Synthetic manager assignment",
        clientNonce: randomUUID(),
      });
      await expect
        .poll(() => f.db.run.findUnique({ where: { id: accepted.runId } }).then((r) => r?.status), {
          timeout: 15000,
        })
        .toBe("completed");
      expect(outputs[0]).toMatchObject({
        tasks: [
          expect.objectContaining({ kind: "contract_coverage", assigneeBotId: f.specialist.id }),
        ],
      });
      expect(outputs[1]).toMatchObject({
        tasks: [expect.objectContaining({ kind: "contract_coverage" })],
      });
      expect(outputs[2]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const works = await f.db.businessCycleWork.findMany({
        where: { cycleId: f.cycle.cycle.id, requestId },
      });
      expect(works).toHaveLength(1);
      const ticket = await f.db.ticket.findUniqueOrThrow({ where: { id: works[0]!.ticketId } });
      expect(ticket).toMatchObject({ createdByBotId: manager.id, assigneeBotId: f.specialist.id });
      await f.runFor(ticket.id);
      expect(await f.db.task.count({ where: { ticketId: ticket.id } })).toBe(1);
      const effects = await f.db.externalEffect.findMany({
        where: { runId: accepted.runId, kind: "business_cycle" },
      });
      expect(
        effects
          .filter((e) => e.status === "completed")
          .map((e) => e.idempotencyKey)
          .sort(),
      ).toEqual(
        [
          toolEffectIdempotencyKey(accepted.runId, "business_cycle", args),
          toolEffectIdempotencyKey(accepted.runId, "business_cycle", args, 1),
        ].sort(),
      );
      expect(new Set(effects.map((e) => e.idempotencyKey)).size).toBe(effects.length);
      const trace = await f.rpc<RunTraceDetail>("runs/detail", { runId: accepted.runId });
      expect(trace.toolTrace.calls.map((c) => c.status)).toEqual([
        "completed",
        "completed",
        "failed",
      ]);
      expect(
        await f.db.tradingExecution.count({ where: { desk: { spaceId: f.actor.spaceId } } }),
      ).toBe(0);
      expect(
        (await f.db.bot.findUniqueOrThrow({ where: { id: manager.id } })).tradingRole,
      ).toBeNull();
    } finally {
      await f.close();
    }
  });
  it.each(["before_write", "after_write"] as const)(
    "recovers a business result interrupted %s without a second side effect, and other bots keep working",
    async (moment) => {
      const f = await fixture();
      const released = gate();
      try {
        const firstResults: unknown[] = [];
        const recoveredResults: unknown[] = [];
        const zombieResults: unknown[] = [];
        let ticketId = "";
        let result!: BusinessWorkResult;
        const submit = (request: Parameters<Plan>[0], executionId: string) =>
          request.executeTool!(
            "business_cycle",
            { operation: "complete", ticketId, result },
            executionId,
          ).catch((error: unknown) => ({
            thrown: error instanceof Error ? error.name : String(error),
          }));
        const locked = gate();
        f.plans.set(f.specialist.id, async function* (request, _context, attempt) {
          if (attempt === 1) {
            await locked.opened;
            firstResults.push(await submit(request, "first-attempt-call"));
            // The process is gone from here on: nothing it later does may count.
            await released.opened;
            zombieResults.push(await submit(request, "zombie-call"));
            yield { type: "done", text: "Stale attempt finished" };
            return;
          }
          // A resumed model re-issues the same logical request under a new provider call id.
          recoveredResults.push(await submit(request, `recovered-call-${attempt}`));
          yield { type: "done", text: "Recovered business result" };
        });
        f.plans.set(f.independent.id, async function* () {
          yield { type: "done", text: "Independent bot finished" };
        });

        const task = await f.assign("contract_coverage");
        ticketId = task.ticketId;
        result = task.result;
        const run = await f.runFor(ticketId);
        await expect.poll(() => f.attempts.get(run.id), { timeout: 15000 }).toBe(1);
        // Freeze the first attempt inside the business write (its identity lock).
        const botLock = await holdRowLock(f.owner, `SELECT id FROM bots WHERE id = $1 FOR UPDATE`, [
          f.specialist.id,
        ]);
        locked.open();
        const inWrite = await blockedBackend(f.owner, "%FROM bots%FOR SHARE%");
        const before = await f.persisted(ticketId, run.id);
        expect(before.evidence).toBe(0);
        expect(before.effects).toEqual([expect.objectContaining({ status: "intended" })]);
        const effectKey = before.effects[0]!.idempotencyKey;

        if (moment === "before_write") {
          // The connection dies inside the business transaction: nothing commits.
          await f.owner.query("SELECT pg_terminate_backend($1)", [inWrite]);
          await botLock.release();
        } else {
          // Let the business transaction commit, then lose the effect bookkeeping that follows.
          const effectLock = await holdRowLock(
            f.owner,
            `SELECT id FROM external_effects WHERE "idempotencyKey" = $1 FOR UPDATE`,
            [effectKey],
          );
          await botLock.release();
          const recording = await blockedBackend(f.owner, "%UPDATE%external_effects%");
          expect((await f.persisted(ticketId, run.id)).evidence).toBe(1);
          await f.owner.query("SELECT pg_terminate_backend($1)", [recording]);
          await effectLock.release();
        }
        await expect.poll(() => firstResults.length, { timeout: 15000 }).toBe(1);

        // The interrupted outcome is reported as unknown, never as a definite failure.
        expect(firstResults[0]).toMatchObject({ uncertain: true });
        const interrupted = await f.persisted(ticketId, run.id);
        expect(interrupted.evidence).toBe(moment === "after_write" ? 1 : 0);
        expect(interrupted.effects).toEqual([{ idempotencyKey: effectKey, status: "intended" }]);
        expect(
          (await f.db.runToolCall.findMany({ where: { runId: run.id } })).map((c) => c.status),
        ).toEqual(["ambiguous"]);

        // An unrelated bot in the same business keeps working while this run is stuck.
        const other = await f.assign("risk_check");
        const otherRun = await f.runFor(other.ticketId);
        await expect
          .poll(
            async () => (await f.db.run.findUniqueOrThrow({ where: { id: otherRun.id } })).status,
            { timeout: 15000 },
          )
          .toBe("completed");
        expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
          "running",
        );

        // The process is presumed dead: its leases expire and recovery hands the run out.
        expect(await f.reconcilerPicks()).not.toContain(run.id);
        await f.expireLeases(run.id);
        expect(await f.reconcilerPicks()).toContain(run.id);
        // Two instances race for the same recovered run; the fenced claim admits one.
        await Promise.all([
          f.recover(run.id, "recovery-instance-a"),
          f.recover(run.id, "recovery-instance-b"),
        ]);
        await expect
          .poll(async () => (await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status, {
            timeout: 15000,
          })
          .toBe("completed");
        expect(recoveredResults).toHaveLength(1);
        expect(recoveredResults[0]).toMatchObject({
          tasks: expect.arrayContaining([expect.objectContaining({ ticketId, status: "done" })]),
        });

        // The stale attempt wakes up and tries again; its lease no longer admits tools.
        released.open();
        await f.awaitIdle!();
        expect(zombieResults).toEqual([{ thrown: "AbortError" }]);

        const after = await f.persisted(ticketId, run.id);
        expect(after.evidence).toBe(1);
        expect(after.comments).toBe(1);
        expect(after.work.result).toEqual(result);
        expect(after.ticket.status).toBe("done");
        // One stable request identity, settled from the real business state.
        expect(after.effects).toEqual([{ idempotencyKey: effectKey, status: "completed" }]);

        const attempts = await f.db.attempt.findMany({
          where: { runId: run.id },
          orderBy: { fence: "asc" },
        });
        expect(attempts.map((a) => a.status)).toEqual(["interrupted", "completed"]);
        const trace = await f.rpc<RunTraceDetail>("runs/detail", { runId: run.id });
        expect(trace.status).toBe("completed");
        // History keeps each attempt's own calls, including the stale attempt's refused retry.
        const [stale, recovered] = attempts;
        expect(
          trace.toolTrace.calls.map((c) => ({ attemptId: c.attemptId, status: c.status })),
        ).toEqual([
          { attemptId: stale!.id, status: "ambiguous" },
          { attemptId: recovered!.id, status: "completed" },
          { attemptId: stale!.id, status: "refused" },
        ]);
      } finally {
        // Let a stalled attempt end even when an assertion failed first.
        released.open();
        await f.close();
      }
    },
    60000,
  );

  it("never re-executes a stopped run during recovery", async () => {
    const f = await fixture();
    const released = gate();
    try {
      const entered = gate();
      f.plans.set(f.specialist.id, async function* () {
        entered.open();
        await released.opened;
        yield { type: "done", text: "Finished after the stop" };
      });
      const task = await f.assign("contract_coverage");
      const run = await f.runFor(task.ticketId);
      await entered.opened;
      await f.rpc("threads/stop", { botId: f.specialist.id });
      released.open();
      await f.awaitIdle!();
      expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "cancelled",
      );
      const before = await f.persisted(task.ticketId, run.id);

      await f.expireLeases(run.id);
      expect(await f.reconcilerPicks()).not.toContain(run.id);
      await f.recover(run.id, "recovery-instance-a");

      expect(f.attempts.get(run.id)).toBe(1);
      expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "cancelled",
      );
      expect(await f.db.attempt.count({ where: { runId: run.id } })).toBe(1);
      expect(await f.persisted(task.ticketId, run.id)).toEqual(before);
    } finally {
      released.open();
      await f.close();
    }
  });

  it("keeps a waiting run waiting through recovery and continues only on a valid answer", async () => {
    const f = await fixture();
    try {
      let ticketId = "";
      let result!: BusinessWorkResult;
      const resumedPrompts: string[] = [];
      f.plans.set(f.specialist.id, async function* (request, _context, attempt) {
        if (attempt === 1) {
          yield { type: "ask", text: "Which contract set should I use?" };
          return;
        }
        resumedPrompts.push(request.prompt);
        await request.executeTool!(
          "business_cycle",
          { operation: "complete", ticketId, result },
          "after-answer",
        );
        yield { type: "done", text: "Recorded after the answer" };
      });
      const task = await f.assign("contract_coverage");
      ticketId = task.ticketId;
      result = task.result;
      const run = await f.runFor(ticketId);
      await expect
        .poll(async () => (await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status, {
          timeout: 15000,
        })
        .toBe("waiting_input");
      await f.awaitIdle!();

      // A restart's recovery pass leaves the wait alone, even with stale lease columns.
      await f.expireLeases(run.id);
      expect(await f.reconcilerPicks()).not.toContain(run.id);
      expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "waiting_input",
      );
      expect(f.attempts.get(run.id)).toBe(1);
      expect((await f.persisted(ticketId, run.id)).evidence).toBe(0);

      // A late or duplicate run.continue (queued before the pause, or redelivered) is not an
      // answer: neither the app's job queue nor another instance's worker may resume the wait.
      await runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
        f.jobs.enqueue(runContinueJob(run.id)),
      );
      await f.awaitIdle!();
      await f.recover(run.id, "late-delivery-instance");
      expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "waiting_input",
      );
      expect(f.attempts.get(run.id)).toBe(1);
      expect(await f.db.attempt.count({ where: { runId: run.id } })).toBe(1);
      expect(resumedPrompts).toEqual([]);

      const question = (await f.snapshot(f.specialist.id)).messages.find(
        (m) => m.runId === run.id && m.blocks.some((b) => b.kind === "ask"),
      )!;
      // An answer for another run is not a valid answer for this one.
      expect(
        (
          await f.response("threads/answer", {
            botId: f.specialist.id,
            runId: randomUUID(),
            messageId: question.id,
            answer: "Use the confirmed contracts",
          })
        ).status,
      ).toBe(409);
      expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "waiting_input",
      );

      await f.rpc("threads/answer", {
        botId: f.specialist.id,
        runId: run.id,
        messageId: question.id,
        answer: "Use the confirmed contracts",
        clientNonce: randomUUID(),
      });
      await expect
        .poll(async () => (await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status, {
          timeout: 15000,
        })
        .toBe("completed");
      await f.awaitIdle!();
      expect(resumedPrompts).toHaveLength(1);
      expect(resumedPrompts[0]).toContain("Use the confirmed contracts");
      const after = await f.persisted(ticketId, run.id);
      expect(after.evidence).toBe(1);
      expect(after.effects.map((e) => e.status)).toEqual(["completed"]);
      expect(await f.db.attempt.count({ where: { runId: run.id } })).toBe(2);
    } finally {
      await f.close();
    }
  });
});

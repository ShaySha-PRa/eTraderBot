import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Actor,
  BusinessCycleState,
  BusinessWorkResult,
  RunTraceDetail,
} from "@rakazo/contracts";
import { currentBusinessEvidence } from "@rakazo/core";
import type { Pool } from "@rakazo/db";
import {
  asSystem,
  createBusinessCycleService,
  createDb,
  createPool,
  createRepos,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

// Real process boundaries: the attempt runs in one child process that is SIGKILLed or
// SIGSTOPped; a newly started child recovers the run on its own once the dead attempt's
// leases expire (five minutes, as in production), through its reconciler and job queue.
const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_MIGRATION_URL);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const childEntry = path.join(repo, "packages/testkit/src/run-recovery-process.ts");
const LEASE_RECOVERY_MS = 7 * 60_000;

type ChildEvent = { pid: number; event: string; runId?: string; port?: number; result?: unknown };

function startChild(name: string, env: NodeJS.ProcessEnv, logDir: string) {
  // Node itself, not the tsx wrapper, so the signals reach the process that runs the work.
  const proc: ChildProcess = spawn(process.execPath, ["--import", "tsx", childEntry], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: ChildEvent[] = [];
  const log = createWriteStream(path.join(logDir, `${name}.log`));
  let buffered = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    log.write(chunk);
    buffered += chunk.toString();
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.startsWith("{")) {
        try {
          events.push(JSON.parse(line) as ChildEvent);
        } catch {
          // Not a child event line.
        }
      }
    }
  });
  proc.stderr!.on("data", (chunk: Buffer) => log.write(chunk));
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  return {
    proc,
    events,
    exited,
    async ready() {
      await expect
        .poll(() => events.find((e) => e.event === "ready"), { timeout: 60_000, interval: 200 })
        .toBeDefined();
      return `http://127.0.0.1:${events.find((e) => e.event === "ready")!.port}`;
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGCONT");
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
        await exited;
        clearTimeout(timer);
      }
      log.end();
    },
  };
}

const heldLocks = new Set<() => Promise<void>>();
async function holdRowLock(owner: Pool, sql: string, params: unknown[]) {
  const client = await owner.connect();
  await client.query("BEGIN");
  const locked = await client.query(sql, params);
  expect(locked.rowCount).toBe(1);
  const release = async () => {
    if (!heldLocks.delete(release)) return;
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  };
  heldLocks.add(release);
  return { release };
}

async function waitForBlockedBackend(owner: Pool, pattern: string) {
  const activity = () =>
    owner
      .query(
        `SELECT usename, state, wait_event_type, left(query, 160) AS query FROM pg_stat_activity
         WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()`,
      )
      .then((r) => JSON.stringify(r.rows));
  await expect
    .poll(
      async () =>
        (
          await owner.query(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND usename = 'rakazo_app'
               AND wait_event_type = 'Lock' AND query ILIKE $1`,
            [pattern],
          )
        ).rowCount,
      { timeout: 30_000 },
    )
    .toBe(1)
    .catch(async (error: unknown) => {
      throw new Error(`${String(error)}\nactivity: ${await activity()}`);
    });
}

async function scenario() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-run-recovery-process-"));
  const logDir = process.env.RUN_RECOVERY_LOG_DIR ?? dir;
  const planFile = path.join(dir, "plan.json");
  await writeFile(planFile, "{}");
  const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5652";
  const env = { ...process.env, RUN_RECOVERY_PLAN: planFile, RUN_RECOVERY_ORIGIN: origin };
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const db = asSystem(prisma);
  const owner = createPool(process.env.DATABASE_MIGRATION_URL!, { poolMax: 4 });
  // Postgres notices a dead client only when it next writes to it, so a statement already
  // sent could still commit after the kill. Have it check, as a real outage eventually does.
  const database = (await owner.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]!.name;
  await owner.query(`ALTER DATABASE "${database}" SET client_connection_check_interval = '500ms'`);
  const children: ReturnType<typeof startChild>[] = [];
  const close = async () => {
    for (const release of [...heldLocks]) await release();
    for (const child of children) await child.stop();
    await prisma.$disconnect();
    await pool.end();
    await owner.end();
    await rm(dir, { recursive: true, force: true });
  };
  const start = async (name: string) => {
    const child = startChild(name, env, logDir);
    children.push(child);
    return { child, base: await child.ready() };
  };

  const first = await start(`${randomUUID().slice(0, 8)}-first`);
  const email = `${randomUUID()}@example.test`;
  const signup = await fetch(`${first.base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: "password12", name: "Synthetic restart" }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const membership = await db.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
  let actor: Actor = {
    userId: user.id,
    email,
    spaceId: membership.spaceId,
    isDeploymentOwner: false,
  };
  const workspace = await runAsSystem("04 restart fixture", () =>
    createTradingWorkspaceService(prisma).createBusinessScope(actor, {
      name: "Synthetic restart business",
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
  const bot = await runAsTenant(actor, () =>
    createRepos(prisma).createBot(actor, {
      name: "Synthetic contracts specialist",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      tradingRole: "mid_long_term",
      tradingWorkspaceId: workspace.id,
    }),
  );
  const cycle = await runAsTenant(actor, () =>
    createBusinessCycleService(prisma).createDemo(actor, randomUUID()),
  );
  const rpc = async <T>(base: string, proc: string, input: unknown): Promise<T> => {
    const res = await fetch(`${base}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        "x-rakazo-space-id": actor.spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.json as T;
  };
  await rpc(first.base, "models/connect", {
    provider: "openrouter",
    modelId: "scripted",
    apiKey: "synthetic-runtime-key",
  });
  const state = await rpc<BusinessCycleState>(first.base, "businessCycle/assign", {
    cycleId: cycle.cycle.id,
    kind: "contract_coverage",
    dependsOn: [],
    requestId: randomUUID(),
  });
  const ticketId = state.tasks[0]!.ticketId;
  const result: BusinessWorkResult = {
    evidenceIds: currentBusinessEvidence(state.evidence)
      .filter((e) => e.streamKey === "contracts")
      .map((e) => e.id),
    summary: "Synthetic sourced contract result",
    disagreements: [],
    unresolved: [],
    improvementProposal: null,
  };
  await expect
    .poll(() => db.run.count({ where: { task: { ticketId } } }), { timeout: 30_000 })
    .toBe(1);
  const run = await db.run.findFirstOrThrow({ where: { task: { ticketId } } });
  await expect
    .poll(() => first.child.events.find((e) => e.event === "attempt" && e.runId === run.id), {
      timeout: 30_000,
    })
    .toBeDefined();
  const persisted = async () => ({
    runs: await db.run.findMany({
      where: { task: { ticketId } },
      select: { id: true, taskId: true },
    }),
    evidence: await db.businessEvidence.count({
      where: { cycleId: cycle.cycle.id, streamKey: `review:${ticketId}` },
    }),
    comments: await db.ticketComment.count({ where: { ticketId } }),
    effects: await db.externalEffect.findMany({
      where: { runId: run.id, kind: "business_cycle" },
      select: { idempotencyKey: true, status: true },
    }),
    ticket: (await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status,
    work: (await db.businessCycleWork.findUniqueOrThrow({ where: { ticketId } })).result,
  });
  return {
    db,
    owner,
    bot,
    run,
    ticketId,
    result,
    first,
    start,
    rpc,
    persisted,
    release: () => writeFile(planFile, JSON.stringify({ [bot.id]: { ticketId, result } })),
    close,
  };
}

describe.skipIf(!enabled).sequential("04 run recovery across a real process restart", () => {
  it.each(["before_write", "after_write"] as const)(
    "a new process recovers a run whose process was killed %s, with one business write",
    async (moment) => {
      const s = await scenario();
      try {
        // Pin the first process inside the business write, at its identity lock.
        const botLock = await holdRowLock(s.owner, `SELECT id FROM bots WHERE id = $1 FOR UPDATE`, [
          s.bot.id,
        ]);
        await s.release();
        await waitForBlockedBackend(s.owner, "%FROM bots%FOR SHARE%");
        const intended = await s.persisted();
        expect(intended.effects).toEqual([expect.objectContaining({ status: "intended" })]);
        const effectKey = intended.effects[0]!.idempotencyKey;
        let effectLock: { release: () => Promise<void> } | undefined;
        if (moment === "after_write") {
          // Let the business transaction commit; pin the effect bookkeeping that follows.
          effectLock = await holdRowLock(
            s.owner,
            `SELECT id FROM external_effects WHERE "idempotencyKey" = $1 FOR UPDATE`,
            [effectKey],
          );
          await botLock.release();
          await waitForBlockedBackend(s.owner, "%UPDATE%external_effects%");
        }
        expect((await s.persisted()).evidence).toBe(moment === "after_write" ? 1 : 0);

        // The executing process dies: no shutdown hook, no requeue, no lease release.
        s.first.child.proc.kill("SIGKILL");
        await s.first.child.exited;
        // Only release the pinned rows once the dead process's statement is gone.
        await expect
          .poll(
            async () =>
              (
                await s.owner.query(
                  `SELECT 1 FROM pg_stat_activity
                   WHERE datname = current_database() AND usename = 'rakazo_app'
                     AND wait_event_type = 'Lock'`,
                )
              ).rowCount,
            { timeout: 30_000 },
          )
          .toBe(0);
        await botLock.release();
        await effectLock?.release();
        const killed = await s.persisted();
        expect(killed.evidence).toBe(moment === "after_write" ? 1 : 0);
        expect(killed.effects).toEqual([{ idempotencyKey: effectKey, status: "intended" }]);
        const orphaned = await s.db.run.findUniqueOrThrow({ where: { id: s.run.id } });
        expect(orphaned.status).toBe("running");
        expect(orphaned.leaseOwner).toMatch(new RegExp(`:${s.first.child.proc.pid}$`));
        expect(s.first.child.events.some((e) => e.event === "tool" && e.runId === s.run.id)).toBe(
          false,
        );

        // A fresh process starts; nothing tells it about the run. It must find it itself.
        const second = await s.start(`${s.run.id}-second`);
        await expect
          .poll(
            async () => (await s.db.run.findUniqueOrThrow({ where: { id: s.run.id } })).status,
            {
              timeout: LEASE_RECOVERY_MS,
              interval: 5_000,
            },
          )
          .toBe("completed");
        const recovered = second.child.events.filter((e) => e.runId === s.run.id);
        expect(recovered.map((e) => e.event)).toEqual(["attempt", "tool"]);
        expect(recovered[1]!.result).toMatchObject({
          tasks: [expect.objectContaining({ ticketId: s.ticketId, status: "done" })],
        });

        const after = await s.persisted();
        expect(after.runs).toEqual([{ id: s.run.id, taskId: s.run.taskId }]);
        expect(after.evidence).toBe(1);
        expect(after.comments).toBe(1);
        expect(after.ticket).toBe("done");
        expect(after.work).toEqual(s.result);
        expect(after.effects).toEqual([{ idempotencyKey: effectKey, status: "completed" }]);
        const attempts = await s.db.attempt.findMany({
          where: { runId: s.run.id },
          orderBy: { fence: "asc" },
        });
        expect(attempts).toHaveLength(2);
        expect(attempts[1]!.status).toBe("completed");
        const trace = await s.rpc<RunTraceDetail>(second.base, "runs/detail", { runId: s.run.id });
        expect(trace.status).toBe("completed");
        expect(trace.toolTrace.calls.map((c) => [c.attemptId, c.status])).toEqual([
          [attempts[0]!.id, expect.stringMatching(/^(pending|ambiguous)$/)],
          [attempts[1]!.id, "completed"],
        ]);
        console.info(
          JSON.stringify({
            moment,
            firstPid: s.first.child.proc.pid,
            secondPid: second.child.proc.pid,
            attempts: attempts.map((a) => ({ fence: a.fence, status: a.status })),
            calls: trace.toolTrace.calls.map((c) => c.status),
            effects: after.effects.length,
            evidence: after.evidence,
          }),
        );
      } finally {
        await s.close();
      }
    },
    LEASE_RECOVERY_MS + 120_000,
  );

  it(
    "a process that stalls past its lease cannot write after another process recovered the run",
    async () => {
      const s = await scenario();
      try {
        // The first process stops dead before its call: no heartbeat, no further work.
        s.first.child.proc.kill("SIGSTOP");
        await s.release();
        const second = await s.start(`${s.run.id}-second`);
        await expect
          .poll(
            async () => (await s.db.run.findUniqueOrThrow({ where: { id: s.run.id } })).status,
            {
              timeout: LEASE_RECOVERY_MS,
              interval: 5_000,
            },
          )
          .toBe("completed");
        expect(second.child.events.filter((e) => e.runId === s.run.id).map((e) => e.event)).toEqual(
          ["attempt", "tool"],
        );
        const recovered = await s.persisted();
        expect(recovered.evidence).toBe(1);

        // The stalled process wakes with its old attempt and tries the same write.
        s.first.child.proc.kill("SIGCONT");
        await expect
          .poll(
            () => s.first.child.events.find((e) => e.event === "tool" && e.runId === s.run.id),
            { timeout: 60_000 },
          )
          .toBeDefined();
        expect(
          s.first.child.events.find((e) => e.event === "tool" && e.runId === s.run.id)!.result,
        ).toEqual({
          thrown: "AbortError",
        });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(await s.persisted()).toEqual(recovered);
        expect((await s.db.run.findUniqueOrThrow({ where: { id: s.run.id } })).status).toBe(
          "completed",
        );
        const trace = await s.rpc<RunTraceDetail>(second.base, "runs/detail", { runId: s.run.id });
        expect(trace.toolTrace.calls.map((c) => c.status)).toEqual(["completed", "refused"]);
      } finally {
        await s.close();
      }
    },
    LEASE_RECOVERY_MS + 120_000,
  );
});

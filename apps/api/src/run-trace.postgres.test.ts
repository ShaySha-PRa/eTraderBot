import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { createDb, createRepos, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutorDeps } from "../../../packages/adapters/src/executor-deps.js";
import { retryRoutineRun } from "../../../packages/adapters/src/run-routines.js";
import { wakeTicketAssignee } from "../../../packages/adapters/src/ticket-wake.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("run traceability (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const system = <T>(fn: () => Promise<T>) => runAsSystem("isolated run trace fixture", fn);
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  const client = (actor: Actor) =>
    createRouterClient(createRouter({ prisma: db.prisma, env: {} } as RouterDeps), {
      context: { actor },
    });
  async function fixture() {
    const actor: Actor = {
      userId: randomUUID(),
      spaceId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      isDeploymentOwner: false,
    };
    await system(async () => {
      const organizationId = randomUUID();
      await db.prisma.user.create({ data: { id: actor.userId, email: actor.email, name: "Test" } });
      await db.prisma.organization.create({
        data: { id: organizationId, name: "Test", slug: organizationId, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: actor.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await db.prisma.space.create({
        data: {
          id: actor.spaceId,
          organizationId,
          createdByUserId: actor.userId,
          name: "Test",
          kind: "general",
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
    });
    const tenant = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    const bot = await tenant(() =>
      createRepos(db.prisma).createBot(actor, {
        name: "Trace Bot",
        instructions: "",
        description: "",
        notifyOnFinish: false,
      }),
    );
    const ticket = await tenant(async () => {
      const board = await db.prisma.board.upsert({
        where: { spaceId: actor.spaceId },
        create: { spaceId: actor.spaceId },
        update: {},
      });
      return db.prisma.ticket.create({
        data: {
          spaceId: actor.spaceId,
          boardId: board.id,
          number: 1,
          title: "Synthetic evidence check",
          assigneeBotId: bot.id,
          createdByUserId: actor.userId,
        },
      });
    });
    const jobs: string[] = [];
    const publisher = {
      enqueue: async (job: unknown) => {
        jobs.push((job as { payload: { runId: string } }).payload.runId);
      },
      cancel: async () => {},
      close: async () => {},
    };
    const wake = () =>
      tenant(() =>
        wakeTicketAssignee(
          { prisma: db.prisma, jobs: publisher, ticketBoardEnabled: true },
          {
            spaceId: actor.spaceId,
            ticketId: ticket.id,
            botId: bot.id,
          },
        ),
      );
    return { actor, bot, ticket, tenant, jobs, publisher, wake, rpc: client(actor) };
  }

  it("links multiple ticket wakes durably and paginates without inferring prompt text", async () => {
    const f = await fixture();
    await f.wake();
    await f.wake();
    const page = await f.rpc.runs.forTicket({ ticketId: f.ticket.id, limit: 1 });
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await f.rpc.runs.forTicket({
      ticketId: f.ticket.id,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect([...page.runs, ...next.runs].map((r) => r.runId).sort()).toEqual([...f.jobs].sort());
    expect(next.nextCursor).toBeNull();
    const detail = await f.rpc.runs.detail({ runId: f.jobs[0]! });
    expect(detail).toMatchObject({
      status: "queued",
      botId: f.bot.id,
      ticket: { id: f.ticket.id, ref: "RAK-1", title: f.ticket.title, status: "todo" },
      timing: { queuedMs: null, durationMs: null, firstResponseMs: null },
      usage: { recordCount: 0, totalTokens: null, costUsd: null, costKnown: false },
      toolTrace: { recorded: false, calls: [], truncated: false },
    });
  });

  it("keeps legacy linkage and missing costs unknown, with timing from stored facts only", async () => {
    const f = await fixture();
    await f.wake();
    const runId = f.jobs[0]!;
    const createdAt = new Date("2030-05-01T00:00:00Z");
    await f.tenant(async () => {
      const run = await db.prisma.run.update({
        where: { id: runId },
        data: {
          status: "failed",
          createdAt,
          startedAt: new Date("2030-05-01T00:00:02Z"),
          firstResponseAt: new Date("2030-05-01T00:00:05Z"),
          completedAt: new Date("2030-05-01T00:00:12Z"),
          error: "Synthetic failure with credential=never-return-this-value",
        },
      });
      await db.prisma.task.update({
        where: { id: run.taskId },
        data: { ticketId: null, prompt: "Work on ticket RAK-1" },
      });
      await db.prisma.usageRecord.createMany({
        data: [
          {
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            runId,
            provider: "synthetic",
            model: "fixture",
            totalTokens: 10,
            costUsd: 0,
          },
          {
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            runId,
            provider: "synthetic",
            model: "fixture",
            totalTokens: null,
            costUsd: null,
          },
        ],
      });
    });
    const unknown = await f.rpc.runs.detail({ runId });
    expect(unknown).toMatchObject({
      ticket: null,
      reason: "failure",
      timing: { queuedMs: 2000, durationMs: 10000, firstResponseMs: 5000 },
      usage: { recordCount: 2, costKnown: false, costUsd: null, totalTokens: null },
      toolTrace: { recorded: false, calls: [] },
    });
    expect(JSON.stringify(unknown)).not.toContain("never-return-this-value");
    expect(JSON.stringify(unknown)).not.toContain("Work on ticket");
    expect((await f.rpc.runs.forTicket({ ticketId: f.ticket.id })).runs).toEqual([]);
    await f.tenant(() =>
      db.prisma.usageRecord.updateMany({
        where: { runId, costUsd: null },
        data: { costUsd: 0, totalTokens: 20 },
      }),
    );
    expect((await f.rpc.runs.detail({ runId })).usage).toEqual({
      recordCount: 2,
      costKnown: true,
      costUsd: 0,
      totalTokens: 30,
    });
    await f.tenant(() =>
      db.prisma.usageRecord.updateMany({ where: { runId }, data: { currency: "eur" } }),
    );
    expect((await f.rpc.runs.detail({ runId })).usage.costUsd).toBeNull();
  });

  it("rejects foreign runs and revoked membership while keeping archived history readable", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.wake();
    const runId = f.jobs[0]!;
    await expect(other.rpc.runs.detail({ runId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { reason: "NOT_FOUND" },
    });
    await expect(other.rpc.runs.forTicket({ ticketId: f.ticket.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await system(async () => {
      const space = await db.prisma.space.findUniqueOrThrow({ where: { id: f.actor.spaceId } });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId: other.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          spaceId: space.id,
          userId: other.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await db.prisma.usageRecord.create({
        data: {
          spaceId: space.id,
          userId: other.actor.userId,
          runId,
          provider: "synthetic",
          model: "private-other-user",
          costUsd: 100,
          totalTokens: 999,
        },
      });
    });
    const peer = client({ ...other.actor, spaceId: f.actor.spaceId });
    await expect(peer.runs.detail({ runId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await peer.runs.forTicket({ ticketId: f.ticket.id })).runs).toEqual([]);
    expect((await f.rpc.runs.detail({ runId })).usage.recordCount).toBe(0);
    await f.tenant(() =>
      db.prisma.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } }),
    );
    expect((await f.rpc.runs.detail({ runId })).botName).toBe("Trace Bot");
    await system(() =>
      db.prisma.spaceMember.deleteMany({
        where: { userId: f.actor.userId, spaceId: f.actor.spaceId },
      }),
    );
    await expect(f.rpc.runs.detail({ runId })).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "FORBIDDEN" },
    });
    await expect(f.rpc.runs.forTicket({ ticketId: f.ticket.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("inherits a recorded ticket through the existing retry path without guessing legacy links", async () => {
    const f = await fixture();
    await f.wake();
    const original = f.jobs[0]!;
    await f.tenant(async () => {
      const routine = await db.prisma.routine.create({
        data: {
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          botId: f.bot.id,
          name: "Synthetic retry",
          prompt: "Retry check",
          crons: ["0 0 * * *"],
          active: true,
        },
      });
      await db.prisma.run.update({
        where: { id: original },
        data: {
          status: "failed",
          trigger: "routine",
          routineId: routine.id,
          completedAt: new Date(),
        },
      });
    });
    // This retry branch needs real persistence and queue publication, never a model/runtime.
    const retryDeps: Partial<ExecutorDeps> = { prisma: db.prisma, jobs: f.publisher };
    await f.tenant(() => retryRoutineRun(retryDeps as ExecutorDeps, original));
    const runs = await f.rpc.runs.forTicket({ ticketId: f.ticket.id });
    expect(runs.runs).toHaveLength(2);
    const retried = runs.runs.find((r) => r.retryOfRunId === original)!;
    expect(retried).toMatchObject({ status: "queued", botId: f.bot.id });
    expect((await f.rpc.runs.detail({ runId: retried.runId })).ticket?.id).toBe(f.ticket.id);
    await f.tenant(() => retryRoutineRun(retryDeps as ExecutorDeps, original));
    expect((await f.rpc.runs.forTicket({ ticketId: f.ticket.id })).runs).toHaveLength(2);
  });

  it("keeps unfinished tool outcomes ambiguous after lease loss and distinguishes waiting from stop", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.wake();
    const runId = f.jobs[0]!;
    const attempt = await f.tenant(async () => {
      await db.prisma.run.update({
        where: { id: runId },
        data: { status: "running", leaseFence: 1, toolTraceVersion: 1 },
      });
      return db.prisma.attempt.create({ data: { runId, fence: 1, status: "running" } });
    });
    expect((await f.rpc.runs.detail({ runId })).toolTrace).toEqual({
      recorded: true,
      calls: [],
      truncated: false,
    });
    const statuses = ["pending", "waiting", "completed", "failed", "refused", "ambiguous"];
    await f.tenant(() =>
      db.prisma.runToolCall.createMany({
        data: statuses.map((status, i) => ({
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          runId,
          attemptId: attempt.id,
          executionId: `tool-${i}`,
          name: "read_file",
          status,
          startedAt: new Date(2030000000000 + i * 1000),
          finishedAt: status === "pending" ? null : new Date(2030000000000 + i * 1000 + 500),
        })),
      }),
    );
    expect((await f.rpc.runs.detail({ runId })).toolTrace.calls.map((c) => c.status)).toEqual(
      statuses,
    );
    expect(
      (await f.rpc.runs.detail({ runId })).toolTrace.calls.every((c) => c.resultSummary === null),
    ).toBe(true);
    expect(await other.tenant(() => db.prisma.runToolCall.count({ where: { runId } }))).toBe(0);
    await expect(
      other.tenant(() =>
        db.prisma.runToolCall.create({
          data: {
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            runId,
            attemptId: attempt.id,
            executionId: "forbidden",
            name: "read_file",
            status: "completed",
          },
        }),
      ),
    ).rejects.toThrow();
    await f.tenant(() => db.prisma.run.update({ where: { id: runId }, data: { leaseFence: 2 } }));
    expect((await f.rpc.runs.detail({ runId })).toolTrace.calls[0]).toMatchObject({
      status: "ambiguous",
      finishedAt: null,
      durationMs: null,
      resultSummary: null,
    });
    for (const kind of ["input", "takeover"] as const) {
      await f.tenant(() =>
        db.prisma.run.update({ where: { id: runId }, data: { status: `waiting_${kind}` } }),
      );
      expect(await f.rpc.runs.detail({ runId })).toMatchObject({
        reason: `waiting_${kind}`,
        waiting: { kind },
      });
    }
    await f.tenant(() =>
      db.prisma.run.update({ where: { id: runId }, data: { status: "cancelled" } }),
    );
    expect(await f.rpc.runs.detail({ runId })).toMatchObject({ reason: "stopped", waiting: null });
    // Read-time uncertainty never rewrites the recorded execution history.
    expect(
      await f.tenant(() => db.prisma.runToolCall.count({ where: { runId, status: "pending" } })),
    ).toBe(1);
  });

  it("reads only whitelisted persisted summaries and never backfills missing historical outcomes", async () => {
    const f = await fixture();
    await f.wake();
    const runId = f.jobs[0]!;
    const marker = "synthetic-private-marker";
    const safe = {
      kind: "readonly_source",
      schemaVersion: 1,
      outcome: "success",
      candidateOnly: true,
      source: {
        kind: "synthetic",
        sourceId: "synthetic-load-example",
        workspaceId: f.actor.spaceId,
        version: "synthetic-load-v1",
        generatedAt: "2026-11-07T16:00:00+08:00",
        timezone: "Asia/Shanghai",
      },
      date: "2026-11-08",
      periods: [
        { start: "2026-11-08T00:00:00+08:00", end: "2026-11-08T01:00:00+08:00", forecastMWh: 12.5 },
      ],
    };
    const attempt = await f.tenant(() =>
      db.prisma.attempt.create({ data: { runId, fence: 1, status: "completed" } }),
    );
    const rows = await f.tenant(async () => {
      const base = {
        spaceId: f.actor.spaceId,
        userId: f.actor.userId,
        runId,
        attemptId: attempt.id,
        name: "mcp__example__read_synthetic_load",
        status: "completed",
      };
      return Promise.all([
        db.prisma.runToolCall.create({
          data: {
            ...base,
            executionId: "safe",
            resultSummary: {
              ...safe,
              arguments: { credential: marker },
              error: marker,
              source: { ...safe.source, authorization: marker },
              periods: safe.periods.map((p) => ({ ...p, raw: marker })),
            },
          },
        }),
        db.prisma.runToolCall.create({
          data: {
            ...base,
            executionId: "foreign",
            resultSummary: { ...safe, source: { ...safe.source, workspaceId: "foreign-business" } },
          },
        }),
        db.prisma.runToolCall.create({ data: { ...base, executionId: "legacy" } }),
        db.prisma.runToolCall.create({
          data: { ...base, executionId: "unknown", status: "pending", resultSummary: safe },
        }),
      ]);
    });
    const trace = await f.rpc.runs.detail({ runId });
    expect(trace.toolTrace.recorded).toBe(false);
    expect(trace.toolTrace.calls.find((c) => c.id === rows[0]!.id)!.resultSummary).toEqual(safe);
    for (const row of rows.slice(1))
      expect(trace.toolTrace.calls.find((c) => c.id === row.id)!.resultSummary).toBeNull();
    expect(trace.toolTrace.calls.find((c) => c.id === rows[3]!.id)!.status).toBe("ambiguous");
    expect(JSON.stringify(trace)).not.toContain(marker);
    // Sanitized readback must not rewrite the stored historical record.
    expect(
      JSON.stringify(
        await f.tenant(() => db.prisma.runToolCall.findUnique({ where: { id: rows[0]!.id } })),
      ),
    ).toContain(marker);
    await expect(
      f.tenant(() =>
        db.prisma.runToolCall.create({
          data: {
            spaceId: f.actor.spaceId,
            userId: f.actor.userId,
            runId,
            attemptId: attempt.id,
            executionId: "oversize",
            name: "read_example",
            status: "completed",
            resultSummary: { raw: "x".repeat(9000) },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("bounds tool summaries and preserves a run when its linked ticket is removed", async () => {
    const f = await fixture();
    await f.wake();
    const runId = f.jobs[0]!;
    await f.tenant(async () => {
      const attempt = await db.prisma.attempt.create({
        data: { runId, fence: 1, status: "completed" },
      });
      await db.prisma.runToolCall.createMany({
        data: Array.from({ length: 201 }, (_, i) => ({
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          runId,
          attemptId: attempt.id,
          executionId: `tool-${i}`,
          name: "list_fleet",
          status: "completed",
          startedAt: new Date(2030000000000 + i * 1000),
        })),
      });
      await db.prisma.ticket.delete({ where: { id: f.ticket.id } });
    });
    const detail = await f.rpc.runs.detail({ runId });
    expect(detail.ticket).toBeNull();
    expect(detail.toolTrace.truncated).toBe(true);
    expect(detail.toolTrace.calls).toHaveLength(200);
    expect(detail.toolTrace.calls[0]?.startedAt).toBe(new Date(2030000000000).toISOString());
    expect(await f.tenant(() => db.prisma.runToolCall.count({ where: { runId } }))).toBe(201);
  });
});

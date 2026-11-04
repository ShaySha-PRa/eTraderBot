import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, TradingScope } from "@rakazo/contracts";
import { TradingLearningReportSchema } from "@rakazo/contracts";
import { createTradingSimulationSnapshot } from "@rakazo/core";
import {
  appendEvent,
  createDb,
  createTradingBotService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "../../../packages/adapters/src/executor.js";
import { tradingTools } from "../../../packages/adapters/src/run-tools-trading.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("scoped trading learning (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const suffix = randomUUID(),
    organizationId = `learning-${suffix}`;
  const actor: Actor = {
    userId: `learning-owner-${suffix}`,
    spaceId: `learning-space-${suffix}`,
    email: `${suffix}@example.test`,
    isDeploymentOwner: false,
  };
  let now = new Date("2026-11-03T00:00:00Z");
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: async () => undefined,
  };
  const client = (who = actor, confirmed = true) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        jobs,
        tradingClock: () => now,
        auth: { hasRecentIdentityConfirmation: async () => confirmed },
      } as unknown as RouterDeps),
      { context: { actor: who, sessionId: "learning-human-session" } },
    );
  const gateway = () => createTradingBotService(db.prisma, () => now, jobs);
  async function tool(botId: string, runId: string, args: Record<string, unknown>) {
    return runAsTenant(actor, () =>
      tradingTools.trading(
        {
          deps: { trading: gateway() },
          run: { ...actor, id: runId },
          bot: { id: botId },
        } as unknown as Parameters<typeof tradingTools.trading>[0],
        {
          args,
          finish: async (value: unknown) => value,
        } as unknown as Parameters<typeof tradingTools.trading>[1],
      ),
    );
  }
  async function setup(kind: TradingScope["subjectKind"] = "generator") {
    const api = client();
    const desk = await api.trading.createDesk({
      scope: {
        subjectId: actor.spaceId,
        subjectKind: kind,
        accountId: "synthetic-account",
        assetId: "synthetic-asset",
        region: "CN-SD",
        marketId: "synthetic",
        productId: "energy",
        stage: "day_ahead",
        environment: "simulation",
      },
      algorithmApproverUserId: actor.userId,
      tradeApproverUserId: actor.userId,
    });
    const botId = randomUUID();
    const thread = await runAsSystem("synthetic learning Bot", async () => {
      await db.prisma.bot.create({
        data: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Learning QA",
          tradingRole: "spot",
          color: "blue",
        },
      });
      return db.prisma.thread.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, botId },
      });
    });
    await api.trading.bindBot({ deskId: desk.id, botId, role: "spot" });
    const start = (key = randomUUID()) =>
      api.trading.startLearning({ deskId: desk.id, botId, clientRequestId: key });
    const open = (runId: string) =>
      tool(botId, runId, { operation: "learning_open", deskId: desk.id }) as Promise<{
        sessionId: string;
        inputHash: string;
        sources: Array<{ id: string; kind: string }>;
        noNewData: boolean;
      }>;
    const source = () =>
      api.trading.addLearningSource({
        deskId: desk.id,
        kind: "chat",
        reference: "synthetic-trader-feedback",
        content:
          "Synthetic scenario: consider a small positive margin while retaining the existing physical constraints.",
      });
    async function history(days = 3) {
      const current = now;
      for (let i = 0; i < days; i++) {
        now = new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86400000);
        await api.trading.simulate({ scope: desk.scope });
      }
      now = current;
    }
    const proposal = (opened: Awaited<ReturnType<typeof open>>) => ({
      sessionId: opened.sessionId,
      sourceIds: opened.sources.map((s) => s.id),
      candidateMargin: "1",
      hypothesis: "Synthetic parameter candidate for constraint comparison only.",
      experience: "Scoped synthetic experience with references; no profitability conclusion.",
    });
    return {
      api,
      desk,
      botId,
      thread,
      start,
      open,
      source,
      history,
      proposal,
      propose: (runId: string, input: ReturnType<typeof proposal>) =>
        tool(botId, runId, { operation: "learning_propose", deskId: desk.id, proposal: input }),
    };
  }
  beforeAll(() =>
    runAsSystem("learning fixtures", async () => {
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic learning owner" },
      });
      await db.prisma.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Synthetic learning",
          createdAt: now,
        },
      });
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: actor.spaceId,
          organizationId,
          name: "Learning",
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
    runAsSystem("learning cleanup", async () => {
      if (!db) return;
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: actor.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it.each(["retailer", "generator", "storage"] as const)(
    "validates %s candidates on fixed train/holdout data and requires human enablement",
    async (kind) => {
      const f = await setup(kind);
      await f.source();
      await f.history();
      const { runId } = await f.start(),
        opened = await f.open(runId);
      expect(opened.sources.filter((source) => source.kind === "history")).toHaveLength(2);
      const report = TradingLearningReportSchema.parse(await f.propose(runId, f.proposal(opened)));
      expect(report).toMatchObject({
        outcome: "proposal",
        validation: "constraints_passed",
        semanticEvaluation: "not_evaluated",
        performanceConclusion: "not_established",
      });
      expect(report.comparisons).toHaveLength(3);
      expect(report.comparisons.filter((r) => r.partition === "train")).toHaveLength(2);
      expect(report.comparisons.filter((r) => r.partition === "holdout")).toHaveLength(1);
      expect(report.sourceIds).toEqual(expect.arrayContaining(opened.sources.map((s) => s.id)));
      let state = await f.api.trading.desk({ deskId: f.desk.id });
      expect(state.versions.find((v) => v.id === report.versionId)).toMatchObject({
        status: "pending",
        validation: { kind: "learning_constraints", reportId: report.id },
      });
      expect(state.grants).toHaveLength(0);
      const version = state.versions.find((v) => v.id === report.versionId)!;
      await expect(
        client(actor, false).trading.approveAlgorithm({
          deskId: f.desk.id,
          versionId: version.id,
          expectedArtifactHash: version.artifactHash,
        }),
      ).rejects.toThrow();
      await f.api.trading.approveAlgorithm({
        deskId: f.desk.id,
        versionId: version.id,
        expectedArtifactHash: version.artifactHash,
      });
      state = await f.api.trading.desk({ deskId: f.desk.id });
      expect(state.versions.find((v) => v.id === version.id)?.status).toBe("approved");
      expect(state.grants).toHaveLength(0);
      // A learned version still needs independent trade permission; use the existing
      // deterministic candidate under synthetic inputs, without claiming strategy quality.
      const analysis = await f.api.trading.simulate({
        scope: f.desk.scope,
        parameters: { margin: "1" },
      });
      const intent = await f.api.trading.prepareIntent({
        deskId: f.desk.id,
        analysisId: analysis.id,
        expiresAt: new Date(now.getTime() + 900_000).toISOString(),
      });
      expect(intent.versionId).toBe(version.id);
      const request = {
        deskId: f.desk.id,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
        clientRequestId: randomUUID(),
      };
      await expect(f.api.trading.executeSimulation(request)).rejects.toMatchObject({
        data: { reason: "TRADE_NOT_APPROVED" },
      });
      await f.api.trading.approveIntent({
        deskId: f.desk.id,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
      });
      await f.api.trading.configureSimulation({ deskId: f.desk.id, scenario: "partial_fill" });
      const execution = await f.api.trading.executeSimulation(request);
      expect(execution.receipt.status).toBe("partially_filled");
      for (const operation of ["reconcile", "cancel"] as const) {
        const command = {
          operation,
          deskId: f.desk.id,
          executionId: execution.id,
          ...(operation === "reconcile"
            ? { expectedSequence: 1 }
            : { clientRequestId: randomUUID() }),
        };
        expect(await tool(f.botId, runId, command)).toMatchObject({ code: "FORBIDDEN" });
      }
      const done = await f.api.trading.reconcileExecution({
        deskId: f.desk.id,
        executionId: execution.id,
        expectedSequence: execution.receipt.sequence,
      });
      expect(done.receipt.status).toBe("filled");
      expect(await f.propose(runId, f.proposal(opened))).toEqual(report);
      expect(await f.propose(runId, { ...f.proposal(opened), candidateMargin: "2" })).toMatchObject(
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      const nextRun = await f.start();
      const nextOpen = await f.open(nextRun.runId);
      expect(nextOpen.sources.some((source) => source.kind === "operation")).toBe(true);
      const evidence = await runAsSystem("inspect synthetic settled learning evidence", () =>
        db.prisma.tradingLearningSource.findMany({
          where: { deskId: f.desk.id, kind: "operation", reference: execution.id },
        }),
      );
      expect(evidence.map((row) => JSON.parse(row.content))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            receipt: expect.objectContaining({ status: "filled", sequence: 2 }),
            receipts: done.receipts,
          }),
        ]),
      );
    },
  );
  it("records invalid historical evidence as a failed validation without publishing a candidate", async () => {
    const f = await setup();
    await f.source();
    await f.history();
    const recorded = (await f.api.trading.history({ limit: 1 }))[0]!;
    const createdAt = new Date("2026-10-05T00:00:00Z");
    const snapshot = createTradingSimulationSnapshot(f.desk.scope, createdAt);
    snapshot.source.validUntil = "2026-10-04T00:00:00Z";
    await runAsSystem("invalid historical source fixture", () =>
      db.prisma.tradingAnalysis.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          snapshot,
          decision: recorded.decision,
          parameters: recorded.parameters,
          createdAt,
        },
      }),
    );
    const run = await f.start(),
      opened = await f.open(run.runId);
    const report = TradingLearningReportSchema.parse(
      await f.propose(run.runId, f.proposal(opened)),
    );
    expect(report.validation).toBe("constraints_failed");
    expect(report.comparisons.some((row) => !row.constraintsPassed && row.error !== null)).toBe(
      true,
    );
    expect(report.versionId).toBeNull();
    expect((await f.api.trading.desk({ deskId: f.desk.id })).versions).toHaveLength(0);
  });
  it("provides a daily default, chat schedule edits, and a durable next wake", async () => {
    const f = await setup();
    const state = await f.api.trading.learningState({ deskId: f.desk.id });
    expect(state.plans[0]).toMatchObject({
      schedule: { time: "02:00", timezone: "Asia/Shanghai", active: true },
    });
    const regular = await runAsSystem("synthetic owner turn", async () => {
      const task = await db.prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: f.botId,
          threadId: f.thread.id,
          prompt: "Update learning plan",
          status: "queued",
        },
      });
      return db.prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: f.botId,
          threadId: f.thread.id,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
    });
    expect(
      await tool(f.botId, regular.id, {
        operation: "learning_schedule",
        deskId: f.desk.id,
        schedule: { time: "05:30", timezone: "Asia/Taipei", active: true },
        baselineMargin: "0",
      }),
    ).toMatchObject({
      schedule: { time: "05:30", timezone: "Asia/Taipei", active: true },
      nextRunAt: expect.any(String),
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
    const routineId = state.plans[0]!.routineId;
    await runAsSystem("general routine schedule edit", async () => {
      await db.prisma.routine.update({ where: { id: routineId }, data: { crons: ["45 6 * * *"] } });
      await expect(
        db.prisma.routine.update({ where: { id: routineId }, data: { crons: ["45 6 * * 1"] } }),
      ).rejects.toThrow();
      await expect(
        db.prisma.routine.update({
          where: { id: routineId },
          data: { prompt: "Changed automation purpose" },
        }),
      ).rejects.toThrow();
    });
    expect((await f.api.trading.learningState({ deskId: f.desk.id })).plans[0]!.schedule.time).toBe(
      "06:45",
    );
    await expect(
      f.api.trading.configureLearning({
        deskId: f.desk.id,
        botId: f.botId,
        schedule: { time: "05:30", timezone: "Invalid/Zone", active: true },
      }),
    ).rejects.toThrow();
  });
  it("coalesces concurrent requests and persists reused request keys across completion", async () => {
    const f = await setup();
    await f.source();
    const key = randomUUID(),
      other = randomUUID();
    const [a, b] = await Promise.all([f.start(key), f.start(other)]);
    expect(a.runId).toBe(b.runId);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    await runAsSystem("finish synthetic learning run", () =>
      db.prisma.run.update({
        where: { id: a.runId },
        data: { status: "failed", error: "Synthetic model connection unavailable" },
      }),
    );
    expect(await f.start(other)).toEqual({ runId: a.runId, reused: true });
    expect((await f.start()).runId).not.toBe(a.runId);
    const state = await f.api.trading.learningState({ deskId: f.desk.id });
    expect(state.sessions.find((s) => s.runId === a.runId)).toMatchObject({
      runStatus: "failed",
      error: expect.any(String),
    });
  });
  it("freezes inputs, queues new evidence separately, and never qualifies insufficient or repeated windows", async () => {
    const f = await setup();
    await f.source();
    await f.history(1);
    const first = await f.start(),
      opened = await f.open(first.runId);
    await f.api.trading.addLearningSource({
      deskId: f.desk.id,
      kind: "file",
      reference: "synthetic.csv",
      content: "day,observation\n1,synthetic\n",
    });
    const next = await f.start();
    expect(next.runId).not.toBe(first.runId);
    const report = TradingLearningReportSchema.parse(
      await f.propose(first.runId, f.proposal(opened)),
    );
    expect(report.validation).toBe("insufficient_data");
    expect(report.versionId).toBeNull();
    expect((await f.open(next.runId)).sources.length).toBeGreaterThan(opened.sources.length);
    const captured = await runAsTenant(actor, () =>
      db.prisma.tradingLearningSession.findUniqueOrThrow({ where: { runId: first.runId } }),
    );
    expect(JSON.stringify(captured.sources)).not.toContain("synthetic.csv");
  });
  it("records no-data and no-new-data results without publishing a version", async () => {
    const f = await setup();
    const first = await f.start();
    expect((await f.open(first.runId)).sources).toHaveLength(0);
    await runAsSystem("complete empty learning", () =>
      db.prisma.run.update({ where: { id: first.runId }, data: { status: "completed" } }),
    );
    const next = await f.start();
    expect((await f.open(next.runId)).noNewData).toBe(true);
    const state = await f.api.trading.learningState({ deskId: f.desk.id });
    expect(state.reports.map((r) => r.outcome).sort()).toEqual(["no_data", "no_new_data"]);
    expect((await f.api.trading.desk({ deskId: f.desk.id })).versions).toHaveLength(0);
  });
  it("attaches actual chat, file, operation and history evidence and rejects cross-scope citations", async () => {
    const f = await setup(),
      other = await setup();
    const message = await runAsSystem("synthetic trader message", () =>
      db.prisma.message.create({
        data: {
          threadId: f.thread.id,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Synthetic trader feedback" }],
        },
      }),
    );
    await f.api.trading.captureLearningMessage({
      deskId: f.desk.id,
      botId: f.botId,
      messageId: message.id,
    });
    await expect(
      other.api.trading.captureLearningMessage({
        deskId: other.desk.id,
        botId: other.botId,
        messageId: message.id,
      }),
    ).rejects.toThrow();
    await f.api.trading.addLearningSource({
      deskId: f.desk.id,
      kind: "file",
      reference: "rules.md",
      content: "Synthetic supplied file.",
    });
    await f.history();
    const analysis = await f.api.trading.simulate({ scope: f.desk.scope });
    const intent = await f.api.trading.prepareIntent({
      deskId: f.desk.id,
      analysisId: analysis.id,
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
    });
    const version = (await f.api.trading.desk({ deskId: f.desk.id })).versions[0]!;
    await f.api.trading.approveAlgorithm({
      deskId: f.desk.id,
      versionId: version.id,
      expectedArtifactHash: version.artifactHash,
    });
    await f.api.trading.approveIntent({
      deskId: f.desk.id,
      intentId: intent.id,
      expectedIntentHash: intent.intent.intentHash,
    });
    await f.api.trading.executeSimulation({
      deskId: f.desk.id,
      intentId: intent.id,
      expectedIntentHash: intent.intent.intentHash,
      clientRequestId: randomUUID(),
    });
    const run = await f.start(),
      opened = await f.open(run.runId);
    expect(new Set(opened.sources.map((s) => s.kind))).toEqual(
      new Set(["chat", "file", "operation", "history"]),
    );
    const foreign = await other.source();
    expect(
      await f.propose(run.runId, { ...f.proposal(opened), sourceIds: [foreign.id] }),
    ).toMatchObject({ code: "FORBIDDEN" });
    const report = TradingLearningReportSchema.parse(
      await f.propose(run.runId, f.proposal(opened)),
    );
    expect(
      await tool(f.botId, run.runId, { operation: "analyze", deskId: f.desk.id }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await tool(f.botId, run.runId, { operation: "context", deskId: other.desk.id }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await runAsTenant(actor, () =>
        gateway().isLearningRun!({ ...actor, botId: f.botId, runId: run.runId }),
      ),
    ).toBe(true);
    await expect(
      client(actor, false).trading.shareLearningExperience({
        deskId: f.desk.id,
        reportId: report.id,
        targetDeskId: other.desk.id,
      }),
    ).rejects.toThrow();
    const shared = await f.api.trading.shareLearningExperience({
      deskId: f.desk.id,
      reportId: report.id,
      targetDeskId: other.desk.id,
    });
    expect(shared.content).toBe(report.experience);
    const target = await other.api.trading.learningState({ deskId: other.desk.id });
    expect(target.sources.some((s) => s.id === shared.id)).toBe(true);
    expect(
      target.sources.some((s) => opened.sources.some((original) => original.id === s.id)),
    ).toBe(false);
    await expect(
      client({ ...actor, userId: "unrelated-synthetic-user" }).trading.learningState({
        deskId: f.desk.id,
      }),
    ).rejects.toThrow();
  });
  it("uses the existing daily scheduler and coalesces missed windows", async () => {
    const f = await setup();
    const plan = (await f.api.trading.learningState({ deskId: f.desk.id })).plans[0]!;
    await runAsSystem("wake missed trading learning", async () => {
      const due = new Date(Date.now() - 3 * 86400000);
      await db.prisma.routine.update({ where: { id: plan.routineId }, data: { nextRunAt: due } });
      const executor = createRunExecutor({
        trading: gateway(),
        prisma: db.prisma,
        jobs,
        events: {
          append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(db.prisma, input),
          notify: async () => undefined,
        },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await Promise.all([
        executor.wakeRoutine(plan.routineId, due.toISOString()),
        executor.wakeRoutine(plan.routineId, due.toISOString()),
      ]);
      expect(await db.prisma.run.count({ where: { routineId: plan.routineId } })).toBe(1);
      expect(
        (
          await db.prisma.routine.findUniqueOrThrow({ where: { id: plan.routineId } })
        ).nextRunAt!.getTime(),
      ).toBeGreaterThan(Date.now());
    });
  });
  it("coalesces daily and manual learning while retaining new inputs as a separate task", async () => {
    const f = await setup();
    await f.source();
    const manual = await f.start();
    const plan = (await f.api.trading.learningState({ deskId: f.desk.id })).plans[0]!;
    const tick = (offset: number) =>
      runAsSystem("daily/manual learning race", async () => {
        const due = new Date(Date.now() - offset);
        await db.prisma.routine.update({ where: { id: plan.routineId }, data: { nextRunAt: due } });
        const executor = createRunExecutor({
          prisma: db.prisma,
          jobs,
          trading: gateway(),
          events: {
            append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(db.prisma, input),
            notify: async () => undefined,
          },
        } as unknown as Parameters<typeof createRunExecutor>[0]);
        await executor.wakeRoutine(plan.routineId, due.toISOString());
      });
    await runAsSystem("lease synthetic learning run", () =>
      db.prisma.run.update({ where: { id: manual.runId }, data: { status: "leased" } }),
    );
    await tick(3 * 86400000);
    expect((await f.api.trading.learningState({ deskId: f.desk.id })).sessions).toHaveLength(1);
    expect(await f.start()).toEqual({ runId: manual.runId, reused: true });
    await f.api.trading.addLearningSource({
      deskId: f.desk.id,
      kind: "file",
      reference: "new-evidence.md",
      content: "Synthetic new input for a later learning task.",
    });
    await tick(2 * 86400000);
    const state = await f.api.trading.learningState({ deskId: f.desk.id });
    expect(state.sessions).toHaveLength(2);
    expect(
      state.sessions.every((session) => session.id !== null && session.inputHash !== null),
    ).toBe(true);
    const next = await f.start();
    expect(next.reused).toBe(true);
    expect(next.runId).not.toBe(manual.runId);
  });
  it("keeps source, session and report evidence immutable, and pauses on unbinding", async () => {
    const f = await setup();
    const source = await f.source(),
      run = await f.start(),
      opened = await f.open(run.runId);
    const report = TradingLearningReportSchema.parse(
      await f.propose(run.runId, f.proposal(opened)),
    );
    await runAsSystem("attempt evidence rewrites", async () => {
      await expect(
        db.prisma.tradingLearningSource.update({
          where: { id: source.id },
          data: { content: "Changed" },
        }),
      ).rejects.toThrow();
      await expect(
        db.prisma.tradingLearningSession.update({
          where: { id: opened.sessionId },
          data: { inputHash: "a".repeat(64) },
        }),
      ).rejects.toThrow();
      await expect(
        db.prisma.tradingLearningReport.update({ where: { id: report.id }, data: { body: {} } }),
      ).rejects.toThrow();
    });
    await f.api.trading.unbindBot({ deskId: f.desk.id, botId: f.botId });
    expect(
      (await f.api.trading.learningState({ deskId: f.desk.id })).plans[0]!.schedule.active,
    ).toBe(false);
    await expect(f.start()).rejects.toThrow();
  });
});

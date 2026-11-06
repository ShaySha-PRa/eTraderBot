import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type {
  Actor,
  BusinessCycleState,
  BusinessWorkKind,
  BusinessWorkResult,
  TradingBotRole,
  TradingScope,
} from "@rakazo/contracts";
import { BusinessImportDataSchema } from "@rakazo/contracts";
import { businessWorkRequirements, currentBusinessEvidence } from "@rakazo/core";
import {
  createBoardEvents,
  createBusinessCycleService,
  createDb,
  createRepos,
  createTradingControlService,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryRealtimeFanout } from "../../../packages/adapters/src/realtime.js";
import { createTicketChangeNotifier } from "../../../packages/adapters/src/ticket-changes.js";
import { updateTicket } from "../../../packages/adapters/src/ticket-tools.js";
import { wakeTicketAssignee } from "../../../packages/adapters/src/ticket-wake.js";
import { recordBusinessSubmission } from "../../../packages/db/src/business-cycle-evidence.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("business cycle review regressions (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const now = new Date("2030-05-01T00:00:00.000Z");
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  async function fixture() {
    const actor: Actor = {
      userId: randomUUID(),
      spaceId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      isDeploymentOwner: false,
    };
    const org = randomUUID();
    const run = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    await runAsSystem("isolated business-cycle regression fixture", async () => {
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic owner" },
      });
      await db.prisma.organization.create({
        data: { id: org, name: "Synthetic", slug: org, createdAt: now },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId: actor.userId,
          role: "owner",
          createdAt: now,
        },
      });
      await db.prisma.space.create({
        data: {
          id: actor.spaceId,
          organizationId: org,
          name: "Synthetic",
          kind: "trading",
          createdByUserId: actor.userId,
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          spaceId: actor.spaceId,
          userId: actor.userId,
          role: "owner",
          createdAt: now,
        },
      });
    });
    const workspace = await run(() =>
      createTradingWorkspaceService(db.prisma, () => now).create(actor, {
        name: "Synthetic regression business",
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
        algorithmApproverUserId: actor.userId,
        tradeApproverUserId: actor.userId,
      }),
    );
    const bots = {} as Record<TradingBotRole, string>;
    const addBot = (role: TradingBotRole) =>
      run(() =>
        createRepos(db.prisma).createBot(actor, {
          name: `Synthetic ${role}`,
          tradingRole: role,
          tradingWorkspaceId: workspace.id,
          instructions: "",
          description: "",
          notifyOnFinish: true,
        }),
      );
    for (const role of ["mid_long_term", "spot", "risk", "review"] as const)
      bots[role] = (await addBot(role)).id;
    const supervisor = await run(() =>
      db.prisma.bot.findFirstOrThrow({
        where: { spaceId: actor.spaceId, businessSupervisor: true },
      }),
    );
    const events: { spaceId: string; ticketId: string }[] = [],
      jobs: unknown[] = [];
    const publisher = {
      enqueue: async (job: unknown) => {
        jobs.push(job);
      },
      cancel: async () => {},
      close: async () => {},
    };
    const boardEvents = createBoardEvents(new InMemoryRealtimeFanout());
    const notify = createTicketChangeNotifier({
      prisma: db.prisma,
      jobs: publisher,
      boardEvents: {
        ...boardEvents,
        notify: async (spaceId, event) => {
          if (event?.ticketId) events.push({ spaceId, ticketId: event.ticketId });
          await boardEvents.notify(spaceId, event);
        },
      } as Parameters<typeof createTicketChangeNotifier>[0]["boardEvents"],
    });
    const service = createBusinessCycleService(db.prisma, () => now, notify);
    const control = createTradingControlService(db.prisma, () => now);
    const client = createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        tradingClock: () => now,
        ticketChanges: notify,
        auth: { hasRecentIdentityConfirmation: async () => true },
      } as unknown as RouterDeps),
      { context: { actor, sessionId: "synthetic-session" } },
    );
    const desks = await run(() => control.desks(actor));
    const cycle = await client.businessCycle.createDemo({ requestId: "cycle" });
    const cycleId = cycle.cycle.id;
    const identity = (role: TradingBotRole | "supervisor") => ({
      ...actor,
      botId: role === "supervisor" ? supervisor.id : bots[role],
    });
    const state = () => client.businessCycle.get({ cycleId });
    async function prepare(stage: TradingScope["stage"]) {
      const deskId = desks.find((d) => d.scope.stage === stage)!.id;
      const analysis = await client.businessCycle.analyze({ cycleId, deskId, margin: "0" });
      const intent = await client.trading.prepareIntent({
        deskId,
        analysisId: analysis.id,
        expiresAt: new Date(now.getTime() + 900000).toISOString(),
      });
      await client.trading.approveAlgorithm({
        deskId,
        versionId: intent.versionId,
        expectedArtifactHash: (await client.trading.desk({ deskId })).versions.find(
          (v) => v.id === intent.versionId,
        )!.artifactHash,
      });
      await client.trading.approveIntent({
        deskId,
        intentId: intent.id,
        expectedIntentHash: intent.intent.intentHash,
      });
      return {
        deskId,
        analysis,
        intent,
        request: {
          deskId,
          intentId: intent.id,
          expectedIntentHash: intent.intent.intentHash,
          clientRequestId: randomUUID(),
        },
      };
    }
    async function assign(kind: BusinessWorkKind, dependsOn: string[] = []) {
      const before = (await state()).tasks.map((t) => t.ticketId);
      const next = await run(() =>
        service.assign(identity("supervisor"), {
          cycleId,
          kind,
          dependsOn,
          requestId: randomUUID(),
        }),
      );
      return next.tasks.find((t) => !before.includes(t.ticketId))!;
    }
    function result(
      state: BusinessCycleState,
      kind: BusinessWorkKind,
      extra: Partial<BusinessWorkResult> = {},
    ): BusinessWorkResult {
      return {
        evidenceIds: currentBusinessEvidence(state.evidence)
          .filter((e) => businessWorkRequirements[kind].evidence.includes(e.streamKey))
          .map((e) => e.id),
        summary: "Synthetic sourced result",
        disagreements: [],
        unresolved: [],
        improvementProposal: null,
        ...extra,
      };
    }
    return {
      actor,
      run,
      client,
      service,
      state,
      cycleId,
      bots,
      supervisor,
      addBot,
      identity,
      prepare,
      assign,
      result,
      events,
      jobs,
      publisher,
      notify,
      boardEvents,
    };
  }

  it.each([
    ["mid_long_term", "day_ahead"],
    ["day_ahead", "mid_long_term"],
  ] as const)(
    "R1: seals %s independently of %s and later old receipt updates",
    async (first, second) => {
      const f = await fixture();
      const a = await f.prepare(first),
        b = await f.prepare(second);
      // A second already-approved intent must also be rejected at execution, not just preparation.
      const duplicate = await f.prepare(first);
      await f.client.trading.configureSimulation({ deskId: a.deskId, scenario: "partial_fill" });
      const execution = await f.client.trading.executeSimulation(a.request);
      await f.client.trading.executeSimulation(b.request);
      await expect(
        f.client.trading.prepareIntent({
          deskId: a.deskId,
          analysisId: a.analysis.id,
          expiresAt: a.intent.intent.expiresAt,
        }),
      ).rejects.toThrow("sealed");
      await expect(f.client.trading.executeSimulation(duplicate.request)).rejects.toThrow("sealed");
      const evidenceCount = (await f.state()).evidence.length;
      expect((await f.client.trading.executeSimulation(a.request)).id).toBe(execution.id);
      expect((await f.state()).evidence).toHaveLength(evidenceCount);
      const reconcile = {
        deskId: a.deskId,
        executionId: execution.id,
        expectedSequence: execution.receipt.sequence,
      };
      await f.client.trading.reconcileExecution(reconcile);
      await f.client.trading.reconcileExecution(reconcile);
      await f.run(() =>
        db.prisma.$transaction((tx) =>
          recordBusinessSubmission(
            tx,
            a.analysis.id,
            {
              executionId: execution.id,
              intentId: a.intent.id,
              status: execution.receipt.status,
              stage: first,
              sequence: execution.receipt.sequence,
            },
            now,
          ),
        ),
      );
      for (const order of [a, b])
        await expect(
          f.client.trading.prepareIntent({
            deskId: order.deskId,
            analysisId: order.analysis.id,
            expiresAt: order.intent.intent.expiresAt,
          }),
        ).rejects.toThrow("sealed");
      const state = await f.state();
      expect(state.evidence.filter((e) => e.kind === "submission")).toHaveLength(3);
      expect(
        new Set(state.evidence.filter((e) => e.kind === "submission").map((e) => e.streamKey)).size,
      ).toBe(2);
    },
  );
  it("S1: archived assignee does not consume readiness; restore dispatches once", async () => {
    const f = await fixture();
    const first = await f.assign("contract_coverage");
    const dependent = await f.assign("spot_analysis", [first.ticketId]);
    expect(dependent.status).toBe("blocked");
    await f.run(() =>
      db.prisma.bot.update({ where: { id: f.bots.spot }, data: { archivedAt: now } }),
    );
    const result = f.result(await f.state(), "contract_coverage");
    await f.run(() => f.service.complete(f.identity("mid_long_term"), first.ticketId, result));
    expect(
      await f.run(() =>
        db.prisma.businessCycleWork.findUniqueOrThrow({ where: { ticketId: dependent.ticketId } }),
      ),
    ).toMatchObject({ dispatched: false });
    expect(f.jobs).toHaveLength(1);
    await f.client.bots.restore({ botId: f.bots.spot });
    expect(f.jobs).toHaveLength(2);
    expect(
      await f.run(() => db.prisma.run.count({ where: { botId: f.bots.spot, trigger: "tickets" } })),
    ).toBe(1);
    expect(await f.run(() => db.prisma.task.count({ where: { botId: f.bots.spot } }))).toBe(1);
    await Promise.all([
      f.client.bots.restore({ botId: f.bots.spot }),
      f.client.bots.restore({ botId: f.bots.spot }),
    ]);
    await f.run(() =>
      wakeTicketAssignee(
        { prisma: db.prisma, jobs: f.publisher },
        { spaceId: f.actor.spaceId, ticketId: dependent.ticketId, botId: f.bots.spot },
      ),
    );
    expect(f.jobs).toHaveLength(2);
  });

  it("S2: deleting an assignee preserves open and completed work; recovery is role constrained", async () => {
    const f = await fixture();
    const open = await f.assign("contract_coverage"),
      done = await f.assign("contract_coverage");
    const result = f.result(await f.state(), "contract_coverage");
    const completed = await f.run(() =>
      f.service.complete(f.identity("mid_long_term"), done.ticketId, result),
    );
    const oldEvidence = completed.evidence.find((e) => e.streamKey === `review:${done.ticketId}`)!;
    await f.run(() => db.prisma.bot.delete({ where: { id: f.bots.mid_long_term } }));
    const after = await f.state();
    expect(after.tasks.map((t) => t.assigneeBotId)).toEqual([null, null]);
    expect(after.tasks.find((t) => t.ticketId === done.ticketId)?.status).toBe("done");
    expect(after.evidence.find((e) => e.id === oldEvidence.id)).toEqual(oldEvidence);
    const contracts = after.evidence.find((e) => e.kind === "contracts")!;
    await f.client.businessCycle.importEvidence({
      cycleId: f.cycleId,
      source: contracts.source,
      sourceRecordId: contracts.sourceRecordId,
      status: contracts.status,
      references: contracts.references,
      data: BusinessImportDataSchema.parse(contracts.data),
    });
    expect((await f.state()).tasks.find((t) => t.ticketId === open.ticketId)).toMatchObject({
      status: "blocked",
      startBlockers: ["assignee:missing"],
    });
    const replacement = await f.addBot("mid_long_term");
    for (const wrong of [f.bots.spot, f.supervisor.id])
      await expect(
        f.client.tickets.update({ id: open.ticketId, assigneeBotId: wrong }),
      ).rejects.toThrow();
    const foreign = await fixture();
    await expect(
      f.client.tickets.update({ id: open.ticketId, assigneeBotId: foreign.bots.mid_long_term }),
    ).rejects.toThrow();
    await f.run(() =>
      db.prisma.bot.update({ where: { id: replacement.id }, data: { archivedAt: now } }),
    );
    await expect(
      f.client.tickets.update({ id: open.ticketId, assigneeBotId: replacement.id }),
    ).rejects.toThrow();
    await f.client.bots.restore({ botId: replacement.id });
    const before = f.jobs.length;
    await f.client.tickets.update({ id: open.ticketId, assigneeBotId: replacement.id });
    expect(f.jobs).toHaveLength(before + 1);
    await expect(
      f.run(() =>
        updateTicket(
          { prisma: db.prisma, onTicketChange: f.notify },
          { ...f.identity("spot"), id: done.ticketId, ownerBotId: replacement.id },
        ),
      ),
    ).rejects.toThrow();
    await f.run(() =>
      updateTicket(
        { prisma: db.prisma, onTicketChange: f.notify },
        { ...f.identity("supervisor"), id: done.ticketId, ownerBotId: replacement.id },
      ),
    );
    expect(f.jobs).toHaveLength(before + 1);
    const recovered = await f.state();
    expect(recovered.tasks.every((t) => t.assigneeBotId === replacement.id)).toBe(true);
    expect(recovered.tasks.find((t) => t.ticketId === open.ticketId)?.status).toBe("todo");
    expect(recovered.tasks.find((t) => t.ticketId === done.ticketId)?.result).toEqual(result);
    expect(recovered.evidence.find((e) => e.id === oldEvidence.id)).toEqual(oldEvidence);
  });

  it("S3: notifies blocked creation and terminal result/comment without extra runs", async () => {
    const f = await fixture();
    const subscription = f.boardEvents.follow(f.actor.spaceId, AbortSignal.timeout(10000));
    const createdEvent = subscription.next();
    const blocked = await f.assign("settlement_review");
    expect((await createdEvent).value).toMatchObject({
      spaceId: f.actor.spaceId,
      ticketId: blocked.ticketId,
    });
    expect(blocked.status).toBe("blocked");
    expect(f.events.filter((e) => e.ticketId === blocked.ticketId)).toHaveLength(1);
    expect(f.jobs).toHaveLength(0);
    const contract = await f.assign("contract_coverage");
    await subscription.next(); // ready contract creation event
    f.events.length = 0;
    const completionEvent = subscription.next();
    const result = f.result(await f.state(), "contract_coverage");
    await f.run(() => f.service.complete(f.identity("mid_long_term"), contract.ticketId, result));
    expect((await completionEvent).value).toMatchObject({
      spaceId: f.actor.spaceId,
      ticketId: contract.ticketId,
    });
    await subscription.return(undefined);
    expect(f.events).toEqual([{ spaceId: f.actor.spaceId, ticketId: contract.ticketId }]);
    expect(f.jobs).toHaveLength(1);
    const comments = await f.run(() =>
      db.prisma.ticketComment.findMany({ where: { ticketId: contract.ticketId } }),
    );
    expect(comments.some((c) => c.body.includes(result.summary))).toBe(true);
  });

  it("R2: queued review starts from raw evidence, investigates a bill difference and reopens after metering correction", async () => {
    const f = await fixture();
    const review = await f.assign("settlement_review");
    const order = await f.prepare("day_ahead");
    const execution = await f.client.trading.executeSimulation(order.request);
    await f.client.businessCycle.demoResults({ cycleId: f.cycleId, executionId: execution.id });
    expect(f.jobs).toHaveLength(0);
    await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "80",
      status: "confirmed",
      requestId: "meter",
    });
    let state = await f.state();
    expect(state.settlement).toBeNull();
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("todo");
    expect(f.jobs).toHaveLength(1);
    const run = await f.run(() =>
      db.prisma.run.findUniqueOrThrow({
        where: { id: (f.jobs[0] as { payload: { runId: string } }).payload.runId },
      }),
    );
    expect(run.botId).toBe(f.bots.review);
    const trial = () =>
      f.run(() =>
        f.service.settle({ spaceId: run.spaceId, userId: run.userId, botId: run.botId }, f.cycleId),
      );
    const bill = currentBusinessEvidence(state.evidence).find((e) => e.kind === "bill")!;
    await f.client.businessCycle.importEvidence({
      cycleId: f.cycleId,
      source: "synthetic-different-bill",
      sourceRecordId: "bill-v1",
      supersedesId: bill.id,
      status: "confirmed",
      references: bill.references,
      data: { kind: "bill", energyAmountCny: "23600", costsCny: null, otherFeesCny: null },
    });
    state = await trial();
    expect(state.settlement).toMatchObject({
      energyAmountCny: "23700",
      billDifferenceCny: "100",
      netProfitCny: null,
    });
    expect(state.reviewReady).toBe(false);
    await expect(
      f.run(() =>
        f.service.complete(
          f.identity("review"),
          review.ticketId,
          f.result(state, "settlement_review"),
        ),
      ),
    ).rejects.toThrow();
    state = await f.run(() =>
      f.service.complete(
        f.identity("review"),
        review.ticketId,
        f.result(state, "settlement_review", { unresolved: ["Synthetic bill differs by 100 CNY"] }),
      ),
    );
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("review");
    const requests = f.jobs.length;
    await trial();
    expect(f.jobs).toHaveLength(requests);
    const currentBill = currentBusinessEvidence(state.evidence).find((e) => e.kind === "bill")!;
    await f.client.businessCycle.importEvidence({
      cycleId: f.cycleId,
      source: "synthetic-corrected-bill",
      sourceRecordId: "bill-v2",
      supersedesId: currentBill.id,
      status: "confirmed",
      references: bill.references,
      data: { kind: "bill", energyAmountCny: "23700", costsCny: null, otherFeesCny: null },
    });
    expect(f.jobs).toHaveLength(requests + 1);
    state = await trial();
    state = await f.run(() =>
      f.service.complete(
        f.identity("review"),
        review.ticketId,
        f.result(state, "settlement_review"),
      ),
    );
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("done");
    const history = state.evidence.map((e) => e.id);
    const meter = currentBusinessEvidence(state.evidence).find((e) => e.kind === "metering")!;
    const correction = {
      cycleId: f.cycleId,
      requestId: "correct-meter",
      energyMwh: "82",
      status: "confirmed" as const,
      supersedesId: meter.id,
    };
    await Promise.all([
      f.client.businessCycle.demoMetering(correction),
      f.client.businessCycle.demoMetering(correction),
    ]);
    expect(f.jobs).toHaveLength(requests + 2);
    state = await f.state();
    expect(state.settlement).toBeNull();
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("todo");
    state = await trial();
    expect(state.settlement).toMatchObject({
      energyAmountCny: "24320",
      equivalentDifferenceCny: "24320",
      netProfitCny: null,
    });
    expect(history.every((id) => state.evidence.some((e) => e.id === id))).toBe(true);
  });

  it("O3: citing this task's previous review preserves the new result without another dispatch", async () => {
    const f = await fixture();
    const task = await f.assign("contract_coverage");
    const firstResult = f.result(await f.state(), "contract_coverage", {
      unresolved: ["Await a contract explanation"],
    });
    let state = await f.run(() =>
      f.service.complete(f.identity("mid_long_term"), task.ticketId, firstResult),
    );
    const first = state.evidence.find((e) => e.streamKey === `review:${task.ticketId}`)!;
    const nextResult = {
      ...firstResult,
      summary: "Updated investigation citing the prior review as history",
      evidenceIds: [...firstResult.evidenceIds, first.id],
    };
    const dispatches = f.jobs.length;
    state = await f.run(() =>
      f.service.complete(f.identity("mid_long_term"), task.ticketId, nextResult),
    );
    expect(state.tasks.find((t) => t.ticketId === task.ticketId)).toMatchObject({
      status: "review",
      result: nextResult,
    });
    expect(f.jobs).toHaveLength(dispatches);
    expect(state.evidence.find((e) => e.id === first.id)).toEqual(first);
    const second = currentBusinessEvidence(state.evidence).find(
      (e) => e.streamKey === first.streamKey,
    )!;
    expect(second).toMatchObject({ supersedesId: first.id, revision: 2 });
    expect(second.data.evidenceIds).toEqual(nextResult.evidenceIds);
    expect(second.references).toEqual(firstResult.evidenceIds);

    // An exact retry now cites a superseded self-review. It must remain idempotent,
    // including concurrent RPC retries, without treating stale business inputs as valid.
    const retries = await Promise.all(
      [0, 1].map(() =>
        f.client.businessCycle.complete({ ticketId: task.ticketId, result: nextResult }),
      ),
    );
    for (const retry of retries) expect(retry).toEqual(state);
    const finalResult = {
      ...nextResult,
      summary: "Investigation resolved; prior investigations remain historical citations",
      evidenceIds: [...nextResult.evidenceIds, second.id],
      unresolved: [],
    };
    state = await f.run(() =>
      f.service.complete(f.identity("mid_long_term"), task.ticketId, finalResult),
    );
    expect(state.tasks.find((t) => t.ticketId === task.ticketId)).toMatchObject({
      status: "done",
      result: finalResult,
    });
    expect(state.evidence.find((e) => e.id === first.id)).toEqual(first);
    expect(state.evidence.find((e) => e.id === second.id)).toEqual(second);
    expect(f.jobs).toHaveLength(dispatches);
    expect(await f.run(() => db.prisma.run.count({ where: { botId: f.bots.mid_long_term } }))).toBe(
      1,
    );
    expect(
      await f.run(() => db.prisma.task.count({ where: { botId: f.bots.mid_long_term } })),
    ).toBe(1);
  });

  it("O3: corrected P25 review can cite its history but cannot reuse obsolete or foreign inputs", async () => {
    const f = await fixture();
    const review = await f.assign("settlement_review");
    const order = await f.prepare("day_ahead");
    const execution = await f.client.trading.executeSimulation(order.request);
    await f.client.businessCycle.demoResults({ cycleId: f.cycleId, executionId: execution.id });
    let state = await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "80",
      status: "confirmed",
      requestId: "meter-80",
    });
    expect(f.jobs).toHaveLength(1);
    const meter = state.evidence.find((e) => e.kind === "metering")!;
    const queuedRun = await f.run(() =>
      db.prisma.run.findUniqueOrThrow({
        where: { id: (f.jobs[0] as { payload: { runId: string } }).payload.runId },
      }),
    );
    const who = { spaceId: queuedRun.spaceId, userId: queuedRun.userId, botId: queuedRun.botId };
    expect(who.botId).toBe(f.bots.review);
    state = await f.run(() => f.service.settle(who, f.cycleId));
    expect(state.settlement?.energyAmountCny).toBe("23700");
    const oldResult = f.result(state, "settlement_review");
    state = await f.run(() => f.service.complete(who, review.ticketId, oldResult));
    const oldEvidence = state.evidence;
    const oldReview = state.evidence.find((e) => e.streamKey === `review:${review.ticketId}`)!;
    const correction = {
      cycleId: f.cycleId,
      energyMwh: "82",
      status: "confirmed" as const,
      supersedesId: meter.id,
      requestId: "meter-82",
    };
    state = await f.client.businessCycle.demoMetering(correction);
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)).toMatchObject({
      status: "todo",
      result: null,
    });
    expect(f.jobs).toHaveLength(2);
    state = await f.run(() => f.service.settle(who, f.cycleId));
    expect(state.settlement).toMatchObject({
      energyAmountCny: "24320",
      equivalentDifferenceCny: "24320",
      billDifferenceCny: "0",
      netProfitCny: null,
    });
    const nextResult = f.result(state, "settlement_review", {
      summary: "Corrected metering reconciled; retain the prior review as history",
      unresolved: ["Costs not supplied; energy settlement is not net profit"],
    });
    nextResult.evidenceIds.push(oldReview.id);
    state = await f.run(() => f.service.complete(who, review.ticketId, nextResult));
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)).toMatchObject({
      status: "review",
      result: nextResult,
    });
    for (const row of oldEvidence) expect(state.evidence.find((e) => e.id === row.id)).toEqual(row);
    expect(await f.client.businessCycle.demoMetering(correction)).toEqual(state);
    expect(
      await f.client.businessCycle.complete({ ticketId: review.ticketId, result: nextResult }),
    ).toEqual(state);

    const foreign = await fixture();
    const foreignTask = await foreign.assign("contract_coverage");
    const foreignState = await foreign.client.businessCycle.complete({
      ticketId: foreignTask.ticketId,
      result: foreign.result(await foreign.state(), "contract_coverage"),
    });
    const foreignReview = foreignState.evidence.find((e) => e.kind === "review")!;
    for (const id of [meter.id, foreignReview.id, randomUUID()]) {
      await expect(
        f.client.businessCycle.complete({
          ticketId: review.ticketId,
          result: { ...nextResult, evidenceIds: [...nextResult.evidenceIds, id] },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "STALE_DATA" } });
    }
    await expect(
      f.client.businessCycle.complete({
        ticketId: review.ticketId,
        result: { ...nextResult, evidenceIds: [oldReview.id] },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "MISSING_EVIDENCE" } });
    for (const role of ["supervisor", "risk"] as const)
      await expect(
        f.run(() => f.service.complete(f.identity(role), review.ticketId, nextResult)),
      ).rejects.toThrow("Only the assigned specialist");
    expect(await f.state()).toEqual(state);
    expect(f.jobs).toHaveLength(2);
    expect(await f.run(() => db.prisma.run.count({ where: { botId: f.bots.review } }))).toBe(2);
    expect(await f.run(() => db.prisma.task.count({ where: { botId: f.bots.review } }))).toBe(2);
  });

  it("O3: another task's review stays a live dependency and its replacement reopens downstream work", async () => {
    const f = await fixture();
    const contract = await f.assign("contract_coverage");
    const risk = await f.assign("risk_check", [contract.ticketId]);
    const contractResult = f.result(await f.state(), "contract_coverage");
    let state = await f.client.businessCycle.complete({
      ticketId: contract.ticketId,
      result: contractResult,
    });
    const contractReview = currentBusinessEvidence(state.evidence).find(
      (e) => e.streamKey === `review:${contract.ticketId}`,
    )!;
    const riskResult = f.result(state, "risk_check");
    state = await f.run(() => f.service.complete(f.identity("risk"), risk.ticketId, riskResult));
    const riskReview = currentBusinessEvidence(state.evidence).find(
      (e) => e.streamKey === `review:${risk.ticketId}`,
    )!;
    const riskRevision = { ...riskResult, evidenceIds: [...riskResult.evidenceIds, riskReview.id] };
    state = await f.run(() => f.service.complete(f.identity("risk"), risk.ticketId, riskRevision));
    const latestRisk = currentBusinessEvidence(state.evidence).find(
      (e) => e.streamKey === riskReview.streamKey,
    )!;
    expect(latestRisk.references).toContain(contractReview.id);
    expect(latestRisk.references).not.toContain(riskReview.id);
    expect(state.tasks.find((t) => t.ticketId === risk.ticketId)?.status).toBe("done");
    expect(f.jobs).toHaveLength(2);
    state = await f.client.businessCycle.complete({
      ticketId: contract.ticketId,
      result: { ...contractResult, summary: "Updated contract interpretation" },
    });
    expect(state.tasks.find((t) => t.ticketId === risk.ticketId)).toMatchObject({
      status: "todo",
      result: null,
    });
    expect(f.jobs).toHaveLength(3);
    await expect(
      f.client.businessCycle.complete({
        ticketId: risk.ticketId,
        result: { ...riskRevision, evidenceIds: [...riskRevision.evidenceIds, contractReview.id] },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "STALE_DATA" } });
    expect(await f.state()).toEqual(state);
    expect(f.jobs).toHaveLength(3);
  });

  it("O1: settlement preserves human review until the assigned Bot explicitly resumes investigation", async () => {
    const f = await fixture();
    const review = await f.assign("settlement_review");
    const order = await f.prepare("day_ahead");
    const execution = await f.client.trading.executeSimulation(order.request);
    await f.client.businessCycle.demoResults({ cycleId: f.cycleId, executionId: execution.id });
    await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "80",
      status: "confirmed",
      requestId: "initial-meter",
    });
    expect(f.jobs).toHaveLength(1);
    const queuedRun = await f.run(() =>
      db.prisma.run.findUniqueOrThrow({
        where: { id: (f.jobs[0] as { payload: { runId: string } }).payload.runId },
      }),
    );
    const who = {
      spaceId: queuedRun.spaceId,
      userId: queuedRun.userId,
      botId: queuedRun.botId,
    };
    expect(who.botId).toBe(f.bots.review);
    let state = await f.run(() => f.service.settle(f.actor, f.cycleId));
    expect(state.settlement?.energyAmountCny).toBe("23700");
    // The real incident had a Bot already working while a human recorded these results.
    const previousResult = f.result(state, "settlement_review");
    state = await f.run(() => f.service.complete(f.actor, review.ticketId, previousResult));
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("done");
    const meter = currentBusinessEvidence(state.evidence).find((e) => e.kind === "metering")!;
    state = await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "82",
      status: "confirmed",
      supersedesId: meter.id,
      requestId: "correct-meter",
    });
    expect(f.jobs).toHaveLength(2);
    const investigation = f.result(state, "settlement_review", {
      summary: "Synthetic human investigation after metering correction",
      unresolved: ["Await the 82 MWh settlement check"],
    });
    state = await f.run(() => f.service.complete(f.actor, review.ticketId, investigation));
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("review");
    const reviewEvidence = state.evidence.filter(
      (e) => e.streamKey === `review:${review.ticketId}`,
    );
    state = await f.run(() => f.service.settle(f.actor, f.cycleId));
    expect(state.settlement?.energyAmountCny).toBe("24320");
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)).toMatchObject({
      status: "review",
      startBlockers: [],
      result: investigation,
    });
    expect(f.jobs).toHaveLength(2);
    await f.run(() =>
      updateTicket(
        { prisma: db.prisma, onTicketChange: f.notify },
        { ...who, id: review.ticketId, status: "doing" },
      ),
    );
    state = await f.state();
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)).toMatchObject({
      status: "doing",
      result: investigation,
    });
    // Resuming work neither approves the unresolved result nor creates another Run.
    await expect(
      f.run(() =>
        updateTicket(
          { prisma: db.prisma, onTicketChange: f.notify },
          { ...who, id: review.ticketId, status: "done" },
        ),
      ),
    ).rejects.toThrow("Submit a sourced result");
    await expect(
      f.run(() => f.service.complete(who, review.ticketId, previousResult)),
    ).rejects.toThrow("superseded evidence");
    state = await f.state();
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.result).toEqual(investigation);
    expect(state.evidence.filter((e) => e.streamKey === `review:${review.ticketId}`)).toEqual(
      reviewEvidence,
    );
    expect(f.jobs).toHaveLength(2);
  });

  it("R2: tentative metering can be investigated but missing or unconfirmed evidence cannot complete review", async () => {
    const f = await fixture();
    const review = await f.assign("settlement_review");
    const order = await f.prepare("day_ahead");
    const execution = await f.client.trading.executeSimulation(order.request);
    await f.client.businessCycle.demoResults({ cycleId: f.cycleId, executionId: execution.id });
    const before = await f.state();
    await expect(
      f.run(() =>
        f.service.complete(
          f.identity("review"),
          review.ticketId,
          f.result(before, "settlement_review"),
        ),
      ),
    ).rejects.toThrow();
    expect(f.jobs).toHaveLength(0);
    await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "80",
      status: "estimated",
      requestId: "estimate",
    });
    let state = await f.state();
    expect(f.jobs).toHaveLength(1);
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)).toMatchObject({
      status: "todo",
      startBlockers: [],
    });
    state = await f.run(() => f.service.settle(f.identity("review"), f.cycleId));
    expect(state.settlement?.energyAmountCny).toBe("23700");
    await expect(
      f.client.tickets.update({ id: review.ticketId, status: "done" }),
    ).rejects.toThrow();
    await expect(
      f.run(() =>
        f.service.complete(
          f.identity("review"),
          review.ticketId,
          f.result(state, "settlement_review"),
        ),
      ),
    ).rejects.toThrow();
    state = await f.run(() =>
      f.service.complete(
        f.identity("review"),
        review.ticketId,
        f.result(state, "settlement_review", { unresolved: ["Await confirmed metering"] }),
      ),
    );
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("review");
    const meter = currentBusinessEvidence(state.evidence).find((e) => e.kind === "metering")!;
    await f.client.businessCycle.demoMetering({
      cycleId: f.cycleId,
      energyMwh: "80",
      status: "confirmed",
      requestId: "confirm",
      supersedesId: meter.id,
    });
    expect(f.jobs).toHaveLength(2);
    state = await f.run(() => f.service.settle(f.identity("review"), f.cycleId));
    state = await f.run(() =>
      f.service.complete(
        f.identity("review"),
        review.ticketId,
        f.result(state, "settlement_review"),
      ),
    );
    expect(state.tasks.find((t) => t.ticketId === review.ticketId)?.status).toBe("done");
  });
});

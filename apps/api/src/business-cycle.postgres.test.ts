import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type {
  Actor,
  BusinessCycleState,
  BusinessWorkResult,
  TradingBotRole,
} from "@rakazo/contracts";
import { businessWorkRequirements, currentBusinessEvidence } from "@rakazo/core";
import {
  createBusinessCycleService,
  createDb,
  createRepos,
  createTradingBotService,
  createTradingControlService,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tradingTools } from "../../../packages/adapters/src/run-tools-trading.js";
import { createTicketChangeNotifier } from "../../../packages/adapters/src/ticket-changes.js";
import { updateTicket } from "../../../packages/adapters/src/ticket-tools.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("business cycle (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const actor: Actor = {
    userId: randomUUID(),
    spaceId: randomUUID(),
    email: `${randomUUID()}@example.test`,
    isDeploymentOwner: false,
  };
  const other = { ...actor, spaceId: randomUUID() },
    general = { ...actor, spaceId: randomUUID() };
  const org = randomUUID(),
    jobs: unknown[] = [];
  let now = new Date("2030-05-01T00:00:00.000Z"),
    cycleId = "",
    supervisorId = "",
    dayDeskId = "",
    realtimeDeskId = "",
    executionId = "",
    generalBotId = "";
  const bots: Partial<Record<TradingBotRole, string>> = {};
  const system = <T>(fn: () => Promise<T>) => runAsSystem("synthetic cycle fixture", fn);
  const tenant = <T>(fn: () => Promise<T>, who = actor) => runAsTenant(who, fn);
  const notify = () =>
    createTicketChangeNotifier({
      prisma: db.prisma,
      boardEvents: { notify: async () => {} } as unknown as Parameters<
        typeof createTicketChangeNotifier
      >[0]["boardEvents"],
      jobs: {
        enqueue: async (job) => {
          jobs.push(job);
        },
        cancel: async () => {},
        close: async () => {},
      },
    });
  const service = () => createBusinessCycleService(db.prisma, () => now, notify());
  const control = () => createTradingControlService(db.prisma, () => now);
  const gateway = () => createTradingBotService(db.prisma, () => now);
  const identity = (role: TradingBotRole | "supervisor") => ({
    ...actor,
    botId: role === "supervisor" ? supervisorId : bots[role]!,
  });
  const client = (who = actor) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        tradingClock: () => now,
        ticketChanges: notify(),
        auth: { hasRecentIdentityConfirmation: async () => true },
      } as unknown as RouterDeps),
      { context: { actor: who, sessionId: "synthetic-session" } },
    );
  const spec = {
    name: "Synthetic P25 business",
    scope: {
      subjectId: "synthetic",
      subjectKind: "generator" as const,
      accountId: "synthetic",
      assetId: "synthetic",
      region: "CN-SD" as const,
      marketId: "synthetic",
      productId: "energy",
      environment: "simulation" as const,
    },
    algorithmApproverUserId: actor.userId,
    tradeApproverUserId: actor.userId,
  };
  function resultFor(
    state: BusinessCycleState,
    ticketId: string,
    extra: Partial<BusinessWorkResult> = {},
  ): BusinessWorkResult {
    const task = state.tasks.find((r) => r.ticketId === ticketId)!;
    return {
      evidenceIds: currentBusinessEvidence(state.evidence)
        .filter((r) => businessWorkRequirements[task.kind].evidence.includes(r.streamKey))
        .map((r) => r.id),
      summary: "Synthetic sourced result; model quality not evaluated.",
      disagreements: [],
      unresolved: [],
      improvementProposal: null,
      ...extra,
    };
  }
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await system(async () => {
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic operator" },
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
      for (const who of [actor, other, general]) {
        await db.prisma.space.create({
          data: {
            id: who.spaceId,
            organizationId: org,
            name: "Synthetic",
            kind: who === general ? "general" : "trading",
            createdByUserId: actor.userId,
          },
        });
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId: org,
            spaceId: who.spaceId,
            userId: actor.userId,
            role: "owner",
            createdAt: now,
          },
        });
      }
    });
    const workspace = await tenant(() =>
      createTradingWorkspaceService(db.prisma, () => now).create(actor, spec),
    );
    await tenant(
      () =>
        createTradingWorkspaceService(db.prisma, () => now).create(other, {
          ...spec,
          name: "Other synthetic business",
        }),
      other,
    );
    for (const role of ["mid_long_term", "spot", "risk", "review"] as const) {
      const bot = await tenant(() =>
        createRepos(db.prisma).createBot(actor, {
          name: `Synthetic ${role}`,
          tradingRole: role,
          tradingWorkspaceId: workspace.id,
          instructions: "",
          description: "",
          notifyOnFinish: true,
        }),
      );
      bots[role] = bot.id;
    }
    const desks = await tenant(() => control().desks(actor));
    dayDeskId = desks.find((d) => d.scope.stage === "day_ahead")!.id;
    realtimeDeskId = desks.find((d) => d.scope.stage === "realtime")!.id;
    supervisorId = (
      await tenant(() =>
        db.prisma.bot.findFirstOrThrow({
          where: { spaceId: actor.spaceId, businessSupervisor: true },
        }),
      )
    ).id;
    generalBotId = (
      await tenant(
        () =>
          createRepos(db.prisma).createBot(general, {
            name: "Synthetic general",
            instructions: "",
            description: "",
            notifyOnFinish: true,
          }),
        general,
      )
    ).id;
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("shares authoritative evidence only within its business and preserves immutable history", async () => {
    const state = await client().businessCycle.createDemo({ requestId: "P25" });
    cycleId = state.cycle.id;
    expect(state.evidence).toHaveLength(3);
    expect(state.reviewReady).toBe(false);
    expect((await client().businessCycle.createDemo({ requestId: "P25" })).cycle.id).toBe(cycleId);
    for (const role of ["mid_long_term", "spot", "risk", "review", "supervisor"] as const)
      expect(
        (await tenant(() => service().get(identity(role), cycleId))).evidence.map((r) => r.id),
      ).toEqual(state.evidence.map((r) => r.id));
    await expect(client(other).businessCycle.get({ cycleId })).rejects.toThrow();
    await expect(
      tenant(() => service().get({ ...general, botId: generalBotId }, cycleId), general),
    ).rejects.toThrow();
    await expect(
      system(() =>
        db.prisma.businessEvidence.update({
          where: { id: state.evidence[0]!.id },
          data: { status: "estimated" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      tenant(() => service().createDemo(identity("supervisor"), "denied")),
    ).rejects.toThrow("requires a human");
    const callTool = (botId: string, args: Record<string, unknown>, who = actor) =>
      tenant(
        () =>
          tradingTools.business_cycle(
            { run: who, bot: { id: botId }, deps: { prisma: db.prisma } } as unknown as Parameters<
              typeof tradingTools.business_cycle
            >[0],
            { args, finish: async (value: unknown) => value } as Parameters<
              typeof tradingTools.business_cycle
            >[1],
          ),
        who,
      );
    expect(await callTool(generalBotId, { operation: "read", cycleId }, general)).toMatchObject({
      code: "WORKSPACE_KIND_MISMATCH",
    });
    expect(
      await callTool(supervisorId, {
        operation: "analyze",
        cycleId,
        deskId: dayDeskId,
        margin: "0",
      }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await callTool(bots.risk!, { operation: "analyze", cycleId, deskId: dayDeskId, margin: "0" }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await callTool(supervisorId, { operation: "read", cycleId })).toMatchObject({
      cycle: { id: cycleId },
    });
  });

  it("dispatches only requested roles, runs independent work, and waits for data and predecessor results", async () => {
    let state = await tenant(() =>
      service().assign(identity("supervisor"), {
        cycleId,
        requestId: "contract",
        kind: "contract_coverage",
      }),
    );
    const contract = state.tasks[0]!;
    expect(jobs).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
    state = await tenant(() =>
      service().assign(identity("supervisor"), {
        cycleId,
        requestId: "dependent-spot",
        kind: "spot_analysis",
        dependsOn: [contract.ticketId],
      }),
    );
    expect(state.tasks[1]?.status).toBe("blocked");
    expect(jobs).toHaveLength(1);
    state = await tenant(() =>
      service().assign(identity("supervisor"), { cycleId, requestId: "risk", kind: "risk_check" }),
    );
    state = await tenant(() =>
      service().assign(identity("supervisor"), {
        cycleId,
        requestId: "independent-spot",
        kind: "spot_analysis",
      }),
    );
    expect(jobs).toHaveLength(3);
    await tenant(() =>
      service().assign(identity("supervisor"), {
        cycleId,
        requestId: "independent-spot",
        kind: "spot_analysis",
      }),
    );
    expect(jobs).toHaveLength(3);
    state = await tenant(() =>
      service().assign(identity("supervisor"), {
        cycleId,
        requestId: "review",
        kind: "settlement_review",
      }),
    );
    const review = state.tasks.at(-1)!;
    expect(review.status).toBe("blocked");
    expect(jobs).toHaveLength(3);
    await expect(
      client().tickets.update({ id: review.ticketId, status: "done" }),
    ).rejects.toThrow();
    await expect(
      tenant(() =>
        updateTicket(
          { prisma: db.prisma, onTicketChange: notify() },
          { ...identity("review"), id: review.ticketId, status: "doing" },
        ),
      ),
    ).rejects.toThrow("waiting");
    await expect(
      tenant(() =>
        service().complete(
          identity("supervisor"),
          contract.ticketId,
          resultFor(state, contract.ticketId),
        ),
      ),
    ).rejects.toThrow("assigned specialist");
    state = await tenant(() =>
      service().complete(
        identity("mid_long_term"),
        contract.ticketId,
        resultFor(state, contract.ticketId, { unresolved: ["Contract interpretation pending"] }),
      ),
    );
    expect(state.tasks[0]?.status).toBe("review");
    expect(jobs).toHaveLength(3);
    state = await tenant(() =>
      service().complete(
        identity("mid_long_term"),
        contract.ticketId,
        resultFor(state, contract.ticketId),
      ),
    );
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.tasks[1]?.status).toBe("todo");
    expect(jobs).toHaveLength(4);
    expect(
      await system(() =>
        db.prisma.run.count({ where: { spaceId: actor.spaceId, trigger: "tickets" } }),
      ),
    ).toBe(4);
  });

  it("separates financial contracts from physical commitments and enforces role, phase and both approval gates", async () => {
    await expect(
      tenant(() =>
        service().analyze(identity("spot"), { cycleId, deskId: dayDeskId, margin: "0" }),
      ),
    ).rejects.toThrow("enable this algorithm");
    for (const role of ["risk", "review", "supervisor"] as const) {
      await expect(
        tenant(() =>
          service().analyze(identity(role), { cycleId, deskId: dayDeskId, margin: "0" }),
        ),
      ).rejects.toThrow("cannot prepare");
    }
    const analysis = await client().businessCycle.analyze({
      cycleId,
      deskId: dayDeskId,
      margin: "0",
    });
    expect(analysis.snapshot.input).toMatchObject({
      kind: "generator",
      intervals: [{ availableEnergyMwh: "90", committedEnergyMwh: "0" }],
    });
    expect(analysis.decision.totalEnergyMwh).toBe("90");
    const rt = await client().businessCycle.analyze({
      cycleId,
      deskId: realtimeDeskId,
      margin: "0",
    });
    await expect(
      client().trading.prepareIntent({
        deskId: realtimeDeskId,
        analysisId: rt.id,
        expiresAt: new Date(now.getTime() + 900000).toISOString(),
      }),
    ).rejects.toThrow("phase");
    const intent = await client().trading.prepareIntent({
      deskId: dayDeskId,
      analysisId: analysis.id,
      expiresAt: new Date(now.getTime() + 900000).toISOString(),
    });
    const request = {
      deskId: dayDeskId,
      intentId: intent.id,
      expectedIntentHash: intent.intent.intentHash,
      clientRequestId: "p25-submit",
    };
    for (const role of ["risk", "review", "supervisor"] as const)
      await expect(
        tenant(() =>
          gateway().call(identity(role), {
            operation: "prepare",
            deskId: dayDeskId,
            analysisId: analysis.id,
          }),
        ),
      ).rejects.toThrow();
    await expect(client().trading.executeSimulation(request)).rejects.toThrow("not enabled");
    await client().trading.approveAlgorithm({
      deskId: dayDeskId,
      versionId: intent.versionId,
      expectedArtifactHash: (await client().trading.desk({ deskId: dayDeskId })).versions.find(
        (r) => r.id === intent.versionId,
      )!.artifactHash,
    });
    expect(
      (
        await tenant(() =>
          service().analyze(identity("spot"), { cycleId, deskId: dayDeskId, margin: "0" }),
        )
      ).decision.totalEnergyMwh,
    ).toBe("90");
    await expect(
      tenant(() =>
        service().analyze(identity("spot"), { cycleId, deskId: dayDeskId, margin: "1" }),
      ),
    ).rejects.toThrow("enable this algorithm");
    await expect(client().trading.executeSimulation(request)).rejects.toThrow(
      "requires single intent",
    );
    await client().trading.approveIntent({
      deskId: dayDeskId,
      intentId: intent.id,
      expectedIntentHash: intent.intent.intentHash,
    });
    const execution = await client().trading.executeSimulation(request);
    executionId = execution.id;
    expect((await client().trading.executeSimulation(request)).id).toBe(executionId);
    await expect(
      client().trading.prepareIntent({
        deskId: dayDeskId,
        analysisId: analysis.id,
        expiresAt: new Date(now.getTime() + 900000).toISOString(),
      }),
    ).rejects.toThrow("sealed");
    const state = await client().businessCycle.get({ cycleId });
    expect(state.evidence.find((r) => r.kind === "submission")?.data.executionId).toBe(executionId);
    expect(state.reviewReady).toBe(false);
    now = new Date(now.getTime() + 3601000);
    const late = await client().businessCycle.analyze({ cycleId, deskId: dayDeskId, margin: "0" });
    await expect(
      client().trading.prepareIntent({
        deskId: dayDeskId,
        analysisId: late.id,
        expiresAt: new Date(now.getTime() + 900000).toISOString(),
      }),
    ).rejects.toThrow("window is closed");
    now = new Date("2030-05-01T00:00:00.000Z");
  });

  it("links clearing, delivery, metering and bills; reconciles P25 without declaring net profit", async () => {
    let state = await client().businessCycle.demoResults({ cycleId, executionId });
    expect(state.reviewReady).toBe(false);
    await expect(client().businessCycle.settle({ cycleId })).rejects.toThrow("metering");
    state = await client().businessCycle.demoMetering({
      cycleId,
      energyMwh: "80",
      status: "estimated",
      requestId: "estimate",
    });
    state = await client().businessCycle.settle({ cycleId });
    expect(state.settlement).toMatchObject({
      energyAmountCny: "23700",
      equivalentDifferenceCny: "23700",
      netProfitCny: null,
      missing: ["costs", "other_fees"],
    });
    expect(state.reviewReady).toBe(false);
    const meter = currentBusinessEvidence(state.evidence).find((r) => r.kind === "metering")!;
    const request = {
      cycleId,
      energyMwh: "80",
      status: "confirmed" as const,
      supersedesId: meter.id,
      requestId: "confirmed",
    };
    state = await client().businessCycle.demoMetering(request);
    const count = state.evidence.length;
    expect((await client().businessCycle.demoMetering(request)).evidence).toHaveLength(count);
    state = await tenant(() => service().settle(identity("review"), cycleId));
    expect(state.reviewReady).toBe(true);
    expect(state.settlement?.lines[0]).toMatchObject({
      contractCny: "30000",
      dayAheadDeviationCny: "-3200",
      realtimeDeviationCny: "-3100",
    });
    const review = state.tasks.find((r) => r.kind === "settlement_review")!;
    expect(review.status).toBe("todo");
    await expect(tenant(() => service().settle(identity("supervisor"), cycleId))).rejects.toThrow();
    state = await tenant(() =>
      service().complete(
        identity("review"),
        review.ticketId,
        resultFor(state, review.ticketId, {
          improvementProposal:
            "Compare forecast errors on a held-out synthetic window; do not enable an algorithm.",
        }),
      ),
    );
    expect(state.tasks.find((r) => r.ticketId === review.ticketId)?.status).toBe("done");
    const before = state.evidence.length;
    expect((await client().businessCycle.settle({ cycleId })).evidence).toHaveLength(before);
  });

  it("appends corrections, invalidates old derived results, and rejects replay conflicts and foreign references", async () => {
    let state = await client().businessCycle.get({ cycleId });
    const old = state.evidence.find(
      (r) => r.kind === "settlement" && r.data.energyAmountCny === "23700",
    )!;
    const meter = currentBusinessEvidence(state.evidence).find((r) => r.kind === "metering")!;
    const request = {
      cycleId,
      energyMwh: "82",
      status: "confirmed" as const,
      supersedesId: meter.id,
      requestId: "corrected",
    };
    await Promise.all([
      client().businessCycle.demoMetering(request),
      client().businessCycle.demoMetering(request),
    ]);
    state = await client().businessCycle.get({ cycleId });
    expect(state.settlement).toBeNull();
    expect(state.reviewReady).toBe(false);
    expect(state.tasks.find((r) => r.kind === "settlement_review")).toMatchObject({
      status: "todo",
      startBlockers: [],
      blockers: ["evidence:settlement"],
    });
    state = await client().businessCycle.settle({ cycleId });
    expect(state.settlement?.energyAmountCny).toBe("24320");
    expect(state.evidence.find((r) => r.id === old.id)?.data.energyAmountCny).toBe("23700");
    await expect(
      client().businessCycle.demoMetering({ ...request, energyMwh: "83" }),
    ).rejects.toThrow("different content");
    const foreign = await client(other).businessCycle.createDemo({ requestId: "foreign" });
    await expect(
      client().businessCycle.importEvidence({
        cycleId,
        source: "synthetic",
        sourceRecordId: "bad-ref",
        status: "confirmed",
        references: [foreign.evidence[0]!.id],
        supersedesId: meter.id,
        data: {
          kind: "metering",
          meterId: "synthetic",
          intervals: [{ start: state.cycle.start, end: state.cycle.end, energyMwh: "80" }],
        },
      }),
    ).rejects.toThrow();
    await expect(
      tenant(() =>
        service().complete(
          identity("review"),
          state.tasks.find((r) => r.kind === "settlement_review")!.ticketId,
          {
            ...resultFor(state, state.tasks.find((r) => r.kind === "settlement_review")!.ticketId),
            evidenceIds: [old.id],
          },
        ),
      ),
    ).rejects.toThrow();
    const contracts = currentBusinessEvidence(state.evidence).find((r) => r.kind === "contracts")!;
    await client().businessCycle.importEvidence({
      cycleId,
      source: "synthetic",
      sourceRecordId: "physical",
      status: "confirmed",
      references: [],
      supersedesId: contracts.id,
      data: {
        kind: "contracts",
        intervals: [
          {
            start: state.cycle.start,
            end: state.cycle.end,
            energyMwh: "100",
            price: "300",
            referencePoint: state.cycle.rule.referencePoint,
            attribute: "physical",
          },
        ],
      },
    });
    await expect(
      client().businessCycle.analyze({ cycleId, deskId: dayDeskId, margin: "0" }),
    ).rejects.toThrow("commitments exceed");
  });
});

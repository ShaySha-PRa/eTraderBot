import { randomUUID } from "node:crypto";
import type {
  BusinessImportInput,
  BusinessWorkResult,
  TradingAnalysis,
  TradingScope,
  TradingSnapshot,
} from "@rakazo/contracts";
import {
  BusinessAssignInputSchema,
  BusinessCycleStateSchema,
  BusinessImportDataSchema,
  BusinessMarketRuleSchema,
  BusinessRecoverySchema,
  BusinessSettlementSchema,
  BusinessWorkResultSchema,
  TradingAnalysisSchema,
  TradingScopeSchema,
} from "@rakazo/contracts";
import {
  businessEvidenceBlockers,
  businessWorkRequirements,
  businessWorkStartEvidence,
  calculateBusinessSettlement,
  createTradingSimulationSnapshot,
  currentBusinessEvidence,
  tradingDecimal as d,
  latestBusinessEvidence,
  runTradingBaseline,
  tradingDecimalString as s,
  tradingAssert,
} from "@rakazo/core";
import { allocateTicketNumber, ensureBoard } from "./board.js";
import type { BusinessIdentity } from "./business-cycle-evidence.js";
import {
  appendBusinessEvidence,
  businessIdentity,
  cycleDto,
  cycleEvidence,
  importBusinessEvidence,
  lockBusinessResultIdentity,
  ownedCycle,
} from "./business-cycle-evidence.js";
import type { BusinessTicketNotifier } from "./business-cycle-work.js";
import {
  businessWorkBlockers,
  cycleWorkState,
  reconcileBusinessWork,
} from "./business-cycle-work.js";
import type { PrismaClient } from "./client.js";
import { checkTradingBot } from "./trading-bot-access.js";
import {
  tradingAlgorithmIdentity,
  tradingCanonical,
  tradingDigest,
  tradingEngineArtifact,
  tradingEngineHash,
} from "./trading-engine.js";

export function createBusinessCycleService(
  prisma: PrismaClient,
  clock: () => Date = () => new Date(),
  notify?: BusinessTicketNotifier,
) {
  const human = (who: BusinessIdentity) =>
    tradingAssert(
      !who.botId,
      "FORBIDDEN",
      "Importing business evidence requires a human; Bots cannot fabricate market evidence",
    );
  async function notifyReady(cycleId: string, changedTicketIds: string[] = []) {
    const changes = await prisma.$transaction((tx) =>
      reconcileBusinessWork(tx, cycleId, changedTicketIds),
    );
    for (const change of changes) await notify?.(change);
  }
  async function get(who: BusinessIdentity, cycleId: string) {
    const { cycle } = await ownedCycle(prisma, who, cycleId);
    const evidence = await cycleEvidence(prisma, cycleId),
      current = currentBusinessEvidence(evidence);
    const settlement = current.find((row) => row.streamKey === "settlement");
    const blockers = businessEvidenceBlockers(
      evidence,
      businessWorkRequirements.settlement_review.evidence,
      true,
    );
    return BusinessCycleStateSchema.parse({
      cycle: cycleDto(cycle),
      evidence,
      tasks: await cycleWorkState(prisma, cycleId, evidence),
      settlement: settlement ? BusinessSettlementSchema.parse(settlement.data) : null,
      reviewReady: blockers.length === 0,
      blockers,
    });
  }
  async function importEvidence(who: BusinessIdentity, input: BusinessImportInput) {
    human(who);
    const result = await prisma.$transaction(async (tx) => {
      const { cycle } = await ownedCycle(tx, who, input.cycleId, true);
      return importBusinessEvidence(tx, cycle, input, clock());
    });
    await notifyReady(input.cycleId);
    return result;
  }
  async function settle(who: BusinessIdentity, cycleId: string) {
    await prisma.$transaction(async (tx) => {
      const { cycle, bot } = await ownedCycle(tx, who, cycleId, true);
      tradingAssert(
        !bot || bot.tradingRole === "review",
        "FORBIDDEN",
        "Only the review specialist or owner can create a settlement trial",
      );
      const evidence = await cycleEvidence(tx, cycleId),
        current = currentBusinessEvidence(evidence);
      tradingAssert(
        businessEvidenceBlockers(evidence, ["submission", "delivery"]).length === 0,
        "MISSING_EVIDENCE",
        "Submission and delivery evidence are required",
      );
      const rule = BusinessMarketRuleSchema.parse(cycle.rule);
      const result = calculateBusinessSettlement(evidence, rule);
      const inputs = current.filter((row) =>
        [
          "contracts",
          "submission",
          "clearing:day_ahead",
          "clearing:realtime",
          "delivery",
          "metering",
          "bill",
        ].includes(row.streamKey),
      );
      const references = inputs.map((r) => r.id).sort();
      const sourceRecordId = tradingDigest(
        tradingCanonical({ references, ruleVersion: rule.version }),
      );
      const prior = latestBusinessEvidence(evidence).find((r) => r.streamKey === "settlement");
      if (prior?.sourceRecordId === sourceRecordId) return;
      await appendBusinessEvidence(
        tx,
        cycleId,
        {
          streamKey: "settlement",
          supersedesId: prior?.id ?? null,
          kind: "settlement",
          status:
            inputs.every((r) => r.status === "confirmed") && result.billDifferenceCny === "0"
              ? "confirmed"
              : "estimated",
          origin: "internal_trial",
          source: "teaching-settlement-v1",
          sourceRecordId,
          references,
          data: result,
        },
        clock(),
        who.botId,
      );
    });
    await notifyReady(cycleId);
    return get(who, cycleId);
  }
  async function analyze(
    who: BusinessIdentity,
    input: { cycleId: string; deskId: string; margin: string },
  ): Promise<TradingAnalysis> {
    return prisma.$transaction(async (tx) => {
      const { cycle, workspace, bot } = await ownedCycle(tx, who, input.cycleId, true);
      tradingAssert(
        !bot || bot.tradingRole === "spot" || bot.tradingRole === "mid_long_term",
        "FORBIDDEN",
        "This Bot cannot prepare trading analysis",
      );
      const desk = await tx.tradingDesk.findFirst({
        where: {
          id: input.deskId,
          spaceId: who.spaceId,
          ownerUserId: who.userId,
          workspaceLink: { workspaceId: workspace.id },
        },
      });
      tradingAssert(desk, "NOT_FOUND", "Trading scenario is outside this business");
      if (who.botId) await checkTradingBot(tx, { ...who, botId: who.botId }, desk.id, true);
      const scope = TradingScopeSchema.parse(desk.scope),
        rule = BusinessMarketRuleSchema.parse(cycle.rule);
      const evidence = await cycleEvidence(tx, cycle.id),
        current = currentBusinessEvidence(evidence);
      tradingAssert(
        businessEvidenceBlockers(evidence, ["contracts", "forecast", "asset"], true).length === 0,
        "MISSING_EVIDENCE",
        "Confirmed contracts, forecast and asset evidence are required",
      );
      const contracts = BusinessImportDataSchema.parse(
        current.find((r) => r.kind === "contracts")!.data,
      );
      const forecast = BusinessImportDataSchema.parse(
        current.find((r) => r.kind === "forecast")!.data,
      );
      const asset = BusinessImportDataSchema.parse(current.find((r) => r.kind === "asset")!.data);
      tradingAssert(
        contracts.kind === "contracts" && forecast.kind === "forecast" && asset.kind === "asset",
        "INVALID_INPUT",
        "Invalid evidence",
      );
      tradingAssert(
        scope.subjectKind !== "storage",
        "INVALID_INPUT",
        "This teaching cycle lacks storage SOC and efficiency evidence; use a generator or retailer simulation",
      );
      const now = clock(),
        snapshot: TradingSnapshot = createTradingSimulationSnapshot(scope, now);
      snapshot.snapshotId = randomUUID();
      snapshot.source.sourceId = `business-cycle:${cycle.id}`;
      snapshot.source.revision = tradingDigest(tradingCanonical(current.map((r) => r.id).sort()));
      snapshot.rules.id = rule.source;
      snapshot.rules.version = rule.version;
      snapshot.rules.effectiveTo = cycle.end.toISOString();
      const rows = forecast.intervals.map((f) => {
        const a = asset.intervals.find((r) => r.start === f.start && r.end === f.end);
        const c = contracts.intervals.filter((r) => r.start === f.start && r.end === f.end);
        tradingAssert(
          a && c.length,
          "MISSING_EVIDENCE",
          "Contract and physical asset intervals must match the forecast",
        );
        const physical = c
          .filter((r) => r.attribute === "physical")
          .reduce((n, r) => n + d(r.energyMwh), d(a.otherPhysicalCommitmentMwh));
        tradingAssert(
          physical <= d(a.availableEnergyMwh),
          "RISK_REJECTED",
          "Physical commitments exceed availability",
        );
        return { f, a, physical };
      });
      snapshot.input =
        scope.subjectKind === "generator"
          ? {
              kind: "generator",
              intervals: rows.map(({ f, a, physical }) => ({
                start: f.start,
                end: f.end,
                availableEnergyMwh: a.availableEnergyMwh,
                committedEnergyMwh: s(physical),
                forecastPrice: f.price,
                segments: [
                  {
                    segmentId: "synthetic-available",
                    energyMwh: a.availableEnergyMwh,
                    marginalCost: a.marginalCost,
                  },
                ],
              })),
            }
          : {
              kind: "retailer",
              intervals: rows.map(({ f, a, physical }) => ({
                start: f.start,
                end: f.end,
                forecastDemandMwh: f.energyMwh,
                contractedEnergyMwh: s(physical),
                purchaseOffers: [
                  {
                    offerId: "synthetic-purchase",
                    price: f.price,
                    availableEnergyMwh: a.availableEnergyMwh,
                  },
                ],
                saleOffers: [
                  {
                    offerId: "synthetic-sale",
                    price: f.price,
                    availableEnergyMwh: a.availableEnergyMwh,
                  },
                ],
              })),
            };
      const parameters = { margin: s(d(input.margin)) };
      const algorithmVersionId = tradingAlgorithmIdentity(scope.subjectKind, parameters);
      if (bot) {
        const version = await tx.tradingVersion.findUnique({
          where: { deskId_algorithmVersionId: { deskId: desk.id, algorithmVersionId } },
        });
        tradingAssert(
          version?.status === "approved",
          "ALGORITHM_NOT_APPROVED",
          "A human must validate and enable this algorithm before a Bot generates candidates",
        );
        tradingAssert(
          version.artifactHash === tradingEngineHash && version.artifact === tradingEngineArtifact,
          "ENGINE_CHANGED",
          "Algorithm engine changed; approve the new version",
        );
      }
      const decision = runTradingBaseline(snapshot, algorithmVersionId, parameters, now);
      const analysis = await tx.tradingAnalysis.create({
        data: {
          id: randomUUID(),
          spaceId: who.spaceId,
          userId: who.userId,
          snapshot,
          decision: { ...decision },
          parameters,
          createdAt: now,
        },
      });
      await tx.businessCycleAnalysis.create({
        data: {
          analysisId: analysis.id,
          cycleId: cycle.id,
          evidenceIds: current
            .filter((r) => ["contracts", "forecast", "asset"].includes(r.kind))
            .map((r) => r.id),
          ruleVersion: rule.version,
        },
      });
      return TradingAnalysisSchema.parse({
        id: analysis.id,
        snapshot: analysis.snapshot,
        decision: analysis.decision,
        parameters: analysis.parameters,
        createdAt: analysis.createdAt.toISOString(),
      });
    });
  }
  return {
    get,
    async recovery(who: BusinessIdentity, ticketId: string) {
      const work = await prisma.businessCycleWork.findFirst({
        where: { ticketId, ticket: { spaceId: who.spaceId } },
        include: { ticket: { include: { assigneeBot: true } } },
      });
      tradingAssert(work, "NOT_FOUND", "Business task not found");
      const { bot } = await ownedCycle(prisma, who, work.cycleId);
      const assignee = work.ticket.assigneeBot;
      const canReplace =
        (!bot || bot.businessSupervisor) && (!assignee || Boolean(assignee.archivedAt));
      const requiredRole =
        businessWorkRequirements[BusinessAssignInputSchema.shape.kind.parse(work.kind)].role;
      const candidates = canReplace
        ? await prisma.bot.findMany({
            where: {
              spaceId: who.spaceId,
              userId: who.userId,
              archivedAt: null,
              tradingRole: requiredRole,
              businessSupervisor: false,
            },
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          })
        : [];
      return BusinessRecoverySchema.parse({
        ticketId,
        cycleId: work.cycleId,
        requiredRole,
        canReplace,
        candidates,
        assignee: assignee
          ? {
              id: assignee.id,
              name: assignee.name,
              archivedAt: assignee.archivedAt?.toISOString() ?? null,
            }
          : null,
      });
    },
    importEvidence,
    settle,
    analyze,
    async list(who: BusinessIdentity) {
      const { workspace } = await businessIdentity(prisma, who);
      return (
        await prisma.businessCycle.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "desc" },
        })
      ).map(cycleDto);
    },
    async createDemo(who: BusinessIdentity, requestId: string) {
      human(who);
      const id = await prisma.$transaction(async (tx) => {
        const { workspace } = await businessIdentity(tx, who);
        const scope = workspace.scope as unknown as Omit<TradingScope, "stage">;
        tradingAssert(
          scope.environment === "simulation",
          "FORBIDDEN",
          "Teaching fixtures are only available in simulation workspaces",
        );
        await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE id=${workspace.id} FOR UPDATE`;
        const prior = await tx.businessCycle.findUnique({
          where: { workspaceId_requestId: { workspaceId: workspace.id, requestId } },
        });
        if (prior) return prior.id;
        const now = clock(),
          start = new Date(now);
        start.setUTCDate(start.getUTCDate() + 1);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + 3600000);
        const samePeriod = await tx.businessCycle.findFirst({
          where: { workspaceId: workspace.id, start, end },
        });
        if (samePeriod) return samePeriod.id;
        const period = { start: start.toISOString(), end: end.toISOString() };
        const rule = BusinessMarketRuleSchema.parse({
          version: "P25-synthetic-v1",
          source: "synthetic-teaching-P25",
          settlementMethod: "teaching_double_deviation",
          referencePoint: "synthetic-common-reference",
          subjectKinds: ["generator", "retailer"],
          stages: ["mid_long_term", "day_ahead", "intraday", "realtime"].map((stage) => ({
            stage,
            mode:
              stage === "day_ahead" || stage === "mid_long_term"
                ? "quantity_price"
                : "results_only",
            opensAt: new Date(now.getTime() - 3600000).toISOString(),
            closesAt: new Date(now.getTime() + 3600000).toISOString(),
            allowRevision: false,
            allowCancellation: false,
            requires: ["contracts", "forecast", "asset"],
          })),
        });
        const cycle = await tx.businessCycle.create({
          data: {
            id: randomUUID(),
            workspaceId: workspace.id,
            requestId,
            name: "P25 · Synthetic teaching cycle",
            start,
            end,
            rule,
            createdAt: now,
          },
        });
        const base = {
          cycleId: cycle.id,
          source: "P25-synthetic-fixture",
          status: "confirmed" as const,
          references: [],
        };
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: "contracts-v1",
            data: {
              kind: "contracts",
              intervals: [
                {
                  ...period,
                  energyMwh: "100",
                  price: "300",
                  referencePoint: rule.referencePoint,
                  attribute: "financial",
                },
              ],
            },
          },
          now,
        );
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: "forecast-v1",
            data: { kind: "forecast", intervals: [{ ...period, energyMwh: "90", price: "320" }] },
          },
          now,
        );
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: "asset-v1",
            data: {
              kind: "asset",
              intervals: [
                {
                  ...period,
                  availableEnergyMwh: "90",
                  otherPhysicalCommitmentMwh: "0",
                  marginalCost: "250",
                },
              ],
            },
          },
          now,
        );
        return cycle.id;
      });
      return get(who, id);
    },
    async demoResults(who: BusinessIdentity, cycleId: string, executionId: string) {
      human(who);
      await prisma.$transaction(async (tx) => {
        const { cycle, workspace } = await ownedCycle(tx, who, cycleId, true);
        const execution = await tx.tradingExecution.findFirst({
          where: { id: executionId, desk: { workspaceLink: { workspaceId: workspace.id } } },
          include: { intent: { include: { desk: true } } },
        });
        const evidence = await cycleEvidence(tx, cycleId),
          submission = currentBusinessEvidence(evidence).find(
            (r) => r.streamKey === "submission" && r.data.executionId === executionId,
          );
        tradingAssert(
          execution && submission && submission.data.stage === "day_ahead",
          "MISSING_EVIDENCE",
          "A linked day-ahead simulated submission is required",
        );
        const rule = BusinessMarketRuleSchema.parse(cycle.rule),
          period = { start: cycle.start.toISOString(), end: cycle.end.toISOString() };
        const base = { cycleId, source: "P25-synthetic-fixture", status: "confirmed" as const };
        const da = await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: `day-ahead:${executionId}`,
            references: [submission.id],
            data: {
              kind: "clearing",
              stage: "day_ahead",
              result: "final",
              intervals: [
                { ...period, energyMwh: "90", price: "320", referencePoint: rule.referencePoint },
              ],
            },
          },
          clock(),
        );
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: `realtime:${executionId}`,
            references: [da.id],
            data: {
              kind: "clearing",
              stage: "realtime",
              result: "final",
              intervals: [
                { ...period, energyMwh: "80", price: "310", referencePoint: rule.referencePoint },
              ],
            },
          },
          clock(),
        );
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: `delivery:${executionId}`,
            references: [da.id],
            data: { kind: "delivery", intervals: [{ ...period, energyMwh: "80" }] },
          },
          clock(),
        );
      });
      await notifyReady(cycleId);
      return get(who, cycleId);
    },
    async demoMetering(
      who: BusinessIdentity,
      input: {
        cycleId: string;
        energyMwh: string;
        status: "estimated" | "confirmed";
        supersedesId?: string;
        requestId: string;
      },
    ) {
      human(who);
      await prisma.$transaction(async (tx) => {
        const { cycle } = await ownedCycle(tx, who, input.cycleId, true);
        const evidence = await cycleEvidence(tx, cycle.id),
          current = currentBusinessEvidence(evidence);
        const delivery = current.find((r) => r.streamKey === "delivery"),
          rt = current.find((r) => r.streamKey === "clearing:realtime");
        tradingAssert(
          delivery && rt,
          "MISSING_EVIDENCE",
          "Delivery and final real-time result must arrive before metering",
        );
        const base = { cycleId: cycle.id, source: "P25-synthetic-fixture", status: input.status };
        const meter = await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: `meter:${input.requestId}`,
            supersedesId: input.supersedesId,
            references: [delivery.id],
            data: {
              kind: "metering",
              meterId: "synthetic-meter",
              intervals: [
                {
                  start: cycle.start.toISOString(),
                  end: cycle.end.toISOString(),
                  energyMwh: input.energyMwh,
                },
              ],
            },
          },
          clock(),
        );
        // Independent simulated bill fixture; it is never called a formal external bill.
        const amount = s(d("23700") + (d(input.energyMwh) - d("80")) * 310n);
        const priorBill = latestBusinessEvidence(evidence).find((r) => r.kind === "bill");
        const priorRequest = evidence.find((r) => r.sourceRecordId === `bill:${input.requestId}`);
        await importBusinessEvidence(
          tx,
          cycle,
          {
            ...base,
            sourceRecordId: `bill:${input.requestId}`,
            supersedesId: priorRequest ? (priorRequest.supersedesId ?? undefined) : priorBill?.id,
            references: [rt.id, meter.id],
            data: { kind: "bill", energyAmountCny: amount, costsCny: null, otherFeesCny: null },
          },
          clock(),
        );
      });
      await notifyReady(input.cycleId);
      return get(who, input.cycleId);
    },
    async assign(who: BusinessIdentity, raw: unknown) {
      const input = BusinessAssignInputSchema.parse(raw);
      const { cycle } = await ownedCycle(prisma, who, input.cycleId);
      const board = await ensureBoard(prisma, who.spaceId);
      const ticketId = await prisma.$transaction(async (tx) => {
        const { bot } = await ownedCycle(tx, who, cycle.id, true);
        const required = businessWorkRequirements[input.kind];
        tradingAssert(
          !bot ||
            bot.businessSupervisor ||
            (bot.tradingRole === "spot" &&
              (input.kind === "contract_coverage" || input.kind === "risk_check")) ||
            (bot.tradingRole === "review" && input.kind !== "settlement_review"),
          "FORBIDDEN",
          "This specialist cannot delegate that business task",
        );
        const prior = await tx.businessCycleWork.findUnique({
          where: { cycleId_requestId: { cycleId: cycle.id, requestId: input.requestId } },
        });
        if (prior) {
          tradingAssert(
            prior.kind === input.kind &&
              tradingCanonical(prior.dependsOn) === tradingCanonical(input.dependsOn),
            "IDEMPOTENCY_CONFLICT",
            "Task request already used with different dependencies",
          );
          return prior.ticketId;
        }
        const assignee = await tx.bot.findFirst({
          where: {
            spaceId: who.spaceId,
            userId: who.userId,
            tradingRole: required.role,
            archivedAt: null,
          },
          orderBy: { id: "asc" },
        });
        tradingAssert(
          assignee,
          "MISSING_EVIDENCE",
          `Create a ${required.role} specialist in this business first`,
        );
        const deps = await tx.businessCycleWork.count({
          where: { cycleId: cycle.id, ticketId: { in: input.dependsOn } },
        });
        tradingAssert(
          deps === new Set(input.dependsOn).size,
          "FORBIDDEN",
          "Task dependencies must already exist in this business cycle",
        );
        const number = await allocateTicketNumber(tx, board.id);
        const ticket = await tx.ticket.create({
          data: {
            spaceId: who.spaceId,
            boardId: board.id,
            number,
            title: `${input.kind} · ${cycle.name}`,
            description: `Use business_cycle read with cycleId ${cycle.id}. Required evidence: ${required.evidence.join(", ")}. Complete with business_cycle complete and sourced evidence IDs; retain disagreements and unresolved issues. This task grants no trading approval or execution permission.`,
            assigneeBotId: assignee.id,
            createdByUserId: who.userId,
            createdByBotId: who.botId ?? null,
            status: "blocked",
          },
        });
        await tx.businessCycleWork.create({
          data: {
            ticketId: ticket.id,
            cycleId: cycle.id,
            requestId: input.requestId,
            kind: input.kind,
            dependsOn: input.dependsOn,
          },
        });
        return ticket.id;
      });
      await notifyReady(cycle.id, [ticketId]);
      return get(who, cycle.id);
    },
    async complete(
      who: BusinessIdentity,
      ticketId: string,
      raw: BusinessWorkResult,
      expectedResultEvidenceId?: string | null,
    ) {
      const result = BusinessWorkResultSchema.parse(raw);
      const work = await prisma.businessCycleWork.findFirst({
        where: { ticketId, ticket: { spaceId: who.spaceId } },
      });
      tradingAssert(work, "NOT_FOUND", "Business task not found");
      await prisma.$transaction(async (tx) => {
        await ownedCycle(tx, who, work.cycleId, true);
        const { bot } = await lockBusinessResultIdentity(tx, who);
        const task = await tx.businessCycleWork.findUniqueOrThrow({
          where: { ticketId },
          include: { ticket: true },
        });
        const kind = BusinessAssignInputSchema.shape.kind.parse(task.kind);
        tradingAssert(
          !bot ||
            (bot.id === task.ticket.assigneeBotId &&
              !bot.businessSupervisor &&
              bot.tradingRole === businessWorkRequirements[kind].role),
          "FORBIDDEN",
          "Only the assigned specialist or human can record this result",
        );
        const evidence = await cycleEvidence(tx, work.cycleId),
          current = currentBusinessEvidence(evidence);
        // This task's earlier reviews are historical citations, not live inputs to
        // their replacement. Keep them in result.evidenceIds for traceability.
        const ownReviews = new Set(
          evidence
            .filter((row) => row.kind === "review" && row.streamKey === `review:${ticketId}`)
            .map((row) => row.id),
        );
        const inputIds = result.evidenceIds.filter((id) => !ownReviews.has(id));
        tradingAssert(
          (
            await businessWorkBlockers(
              tx,
              task,
              evidence,
              result.unresolved.length ? "start" : "complete",
            )
          ).length === 0,
          "MISSING_EVIDENCE",
          "Required evidence or predecessor result is still missing",
        );
        tradingAssert(
          inputIds.every((id) => current.some((row) => row.id === id)),
          "STALE_DATA",
          "Result references missing, foreign or superseded evidence",
        );
        const required = result.unresolved.length
          ? businessWorkStartEvidence(kind)
          : businessWorkRequirements[kind].evidence;
        tradingAssert(
          required.every((key) =>
            current.some((row) => row.streamKey === key && inputIds.includes(row.id)),
          ),
          "MISSING_EVIDENCE",
          "Result must reference all required evidence versions",
        );
        const dependencies = Array.isArray(task.dependsOn)
          ? task.dependsOn.filter((id): id is string => typeof id === "string")
          : [];
        const previous = await tx.businessCycleWork.findMany({
          where: { cycleId: work.cycleId, ticketId: { in: dependencies } },
        });
        const refs = [
          ...new Set([
            ...inputIds,
            ...previous.flatMap((r) => (r.resultEvidenceId ? [r.resultEvidenceId] : [])),
          ]),
        ].sort();
        const head = latestBusinessEvidence(evidence).find(
          (r) => r.streamKey === `review:${ticketId}`,
        );
        const replay = Boolean(
          head &&
            task.resultEvidenceId === head.id &&
            tradingCanonical(task.result) === tradingCanonical(result) &&
            tradingCanonical([...head.references].sort()) === tradingCanonical(refs),
        );
        tradingAssert(
          replay || (head?.id ?? null) === (expectedResultEvidenceId ?? null),
          "STALE_DATA",
          "A newer work result exists. Read the current findings and unresolved issues before submitting a replacement.",
        );
        // A retry acknowledges the stored result; it must not undo a specialist's
        // subsequent explicit transition back to doing.
        if (replay) return;
        // Bind a new receipt to its predecessor: A -> B -> A is a new revision,
        // while an exact retry above still acknowledges the existing head.
        const sourceRecordId = tradingDigest(
          tradingCanonical({ ticketId, result, refs, previousResultEvidenceId: head?.id ?? null }),
        );
        const record = await appendBusinessEvidence(
          tx,
          work.cycleId,
          {
            streamKey: `review:${ticketId}`,
            kind: "review",
            supersedesId: head?.id ?? null,
            status: result.unresolved.length ? "estimated" : "confirmed",
            origin: "internal_trial",
            source: "business-task-result",
            sourceRecordId,
            references: refs,
            data: {
              ...result,
              ticketId,
              authorBotId: who.botId ?? null,
              authorUserId: who.userId,
              proposalStatus: "not_enabled",
            },
          },
          clock(),
          who.botId,
        );
        await tx.businessCycleWork.update({
          where: { ticketId },
          data: { result, resultEvidenceId: record.id },
        });
        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            status: result.unresolved.length ? "review" : "done",
            completedAt: result.unresolved.length ? null : clock(),
          },
        });
        const comment = await tx.ticketComment.findFirst({
          where: { ticketId, body: `Evidence result ${record.id}\n${result.summary}` },
        });
        if (!comment)
          await tx.ticketComment.create({
            data: {
              spaceId: who.spaceId,
              ticketId,
              body: `Evidence result ${record.id}\n${result.summary}`,
              authorBotId: who.botId ?? null,
              authorUserId: who.userId,
            },
          });
      });
      await notifyReady(work.cycleId, [ticketId]);
      return get(who, work.cycleId);
    },
  };
}

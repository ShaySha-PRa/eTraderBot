import { randomUUID } from "node:crypto";
import type { Actor, TradingControlInputs, TradingStoredIntent } from "@rakazo/contracts";
import {
  TradingAuditSchema,
  TradingBotBindingSchema,
  TradingBotRoleSchema,
  TradingDeskSchema,
  TradingExecutionSchema,
  TradingGrantSchema,
  TradingIntentSchema,
  TradingReceiptSchema,
  TradingSimulationScenarioSchema,
  TradingStoredIntentSchema,
  TradingVersionSchema,
  tradingBotSupportsStage,
} from "@rakazo/contracts";
import {
  tradingDecimal as d,
  runTradingBaseline,
  tradingDecimalString as s,
  simulateTradingExecution,
  tradingAssert,
  tradingExecutionBalance,
  tradingExecutionTerminal,
  validateTradingSnapshot,
} from "@rakazo/core";
import { assertBusinessSubmission, recordBusinessSubmission } from "./business-cycle-evidence.js";
import type { Prisma, PrismaClient } from "./client.js";
import { Prisma as PrismaRuntime } from "./client.js";
import { createTradingAnalysisService } from "./trading.js";
import { checkTradingBot } from "./trading-bot-access.js";
import {
  tradingAlgorithmIdentity,
  tradingCanonical,
  tradingDigest,
  tradingEngineArtifact,
  tradingEngineHash,
} from "./trading-engine.js";
import { ensureTradingLearningPlan } from "./trading-learning.js";
import { groupTradingDesk } from "./trading-workspaces.js";
import { withTransactionRetry } from "./transaction-retry.js";
import { requireWorkspaceKind } from "./workspace-isolation.js";

type Inputs = TradingControlInputs;
type Tx = Prisma.TransactionClient;

function wire(row: object) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== "requestHash")
      .map(([key, value]) => [
        key,
        value instanceof Date
          ? value.toISOString()
          : value instanceof PrismaRuntime.Decimal
            ? value.toFixed()
            : value,
      ]),
  );
}
const intentDto = (row: object) => TradingStoredIntentSchema.parse(wire(row));
const versionDto = (row: object) => TradingVersionSchema.parse(wire(row));
const grantDto = (row: object) => TradingGrantSchema.parse(wire(row));
const executionInclude = { events: { orderBy: { sequence: "asc" as const } } };
type Execution = Prisma.TradingExecutionGetPayload<{ include: typeof executionInclude }>;
const executionDto = (row: Execution) => {
  const { events, simulationScenario: _scenario, ...record } = row;
  const receipts = [row.receipt, ...events.map((event) => event.receipt)].map((receipt) =>
    TradingReceiptSchema.parse(receipt),
  );
  return TradingExecutionSchema.parse({ ...wire(record), receipt: receipts.at(-1), receipts });
};
const same = (a: unknown, b: unknown) => tradingCanonical(a) === tradingCanonical(b);
const digest = (value: unknown) => tradingDigest(tradingCanonical(value));

function checkIntent(record: TradingStoredIntent, now: Date) {
  const { intentHash, ...unsigned } = record.intent;
  tradingAssert(digest(unsigned) === intentHash, "INTENT_CHANGED", "Intent integrity check failed");
  tradingAssert(Date.parse(record.intent.expiresAt) > now.getTime(), "EXPIRED", "Intent expired");
  const snapshot = validateTradingSnapshot(record.snapshot, now);
  tradingAssert(
    snapshot.scope.environment === "simulation",
    "ENVIRONMENT_MISMATCH",
    "Simulation only",
  );
  tradingAssert(
    same(snapshot.scope, record.intent.scope),
    "SCOPE_MISMATCH",
    "Intent scope mismatch",
  );
  tradingAssert(
    snapshot.input.intervals.every((row) => Date.parse(row.start) > now.getTime()),
    "EXPIRED",
    "Delivery interval already started",
  );
  const algorithmId = tradingAlgorithmIdentity(snapshot.scope.subjectKind, record.parameters);
  tradingAssert(
    algorithmId === record.intent.algorithmVersionId,
    "ENGINE_CHANGED",
    "Algorithm needs a new version and approval",
  );
  const decision = runTradingBaseline(snapshot, algorithmId, record.parameters, now);
  tradingAssert(
    same(decision.lines, record.intent.lines) &&
      decision.snapshotId === record.intent.snapshotId &&
      decision.ruleVersion === record.intent.ruleVersion &&
      d(decision.grossNotionalCny) === d(record.grossNotionalCny),
    "INTENT_CHANGED",
    "Intent no longer matches its evidence",
  );
  tradingAssert(
    d(decision.uncoveredEnergyMwh) === 0n && decision.warnings.length === 0,
    "RISK_REJECTED",
    "Uncovered exposure requires review",
  );
  return decision;
}

/** One service for RPC, future Bot tools and background execution. No network side effects
 * occur inside the transaction: this synthetic venue persists receipts and accounting atomically. */
export function createTradingControlService(
  prisma: PrismaClient,
  clock: () => Date = () => new Date(),
) {
  const analyses = createTradingAnalysisService(prisma, clock);
  async function desk(db: Tx | PrismaClient, actor: Actor, id: string) {
    const row = await db.tradingDesk.findFirst({
      where: {
        id,
        spaceId: actor.spaceId,
        OR: [
          { ownerUserId: actor.userId },
          { algorithmApproverUserId: actor.userId },
          { tradeApproverUserId: actor.userId },
        ],
      },
    });
    tradingAssert(row, "NOT_FOUND", "Trading scope not found");
    return TradingDeskSchema.parse(wire(row));
  }
  async function audit(
    tx: Tx,
    actor: Actor,
    deskId: string,
    kind: string,
    recordId: string,
    now: Date,
  ) {
    await tx.tradingAudit.create({
      data: { id: randomUUID(), deskId, actorUserId: actor.userId, kind, recordId, createdAt: now },
    });
  }
  function change<T>(
    actor: Actor,
    deskId: string,
    action: (tx: Tx, scope: Awaited<ReturnType<typeof desk>>, now: Date) => Promise<T>,
  ) {
    return withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        // Lock only this business scope. Revocation, retirement, retries and cumulative limits
        // use the same lock across API processes, so a grant cannot be spent twice.
        await tx.$queryRaw`SELECT id FROM trading_desks WHERE id = ${deskId} FOR UPDATE`;
        const scope = await desk(tx, actor, deskId);
        return action(tx, scope, clock());
      }),
    );
  }
  function requireRole(actor: Actor, userId: string) {
    tradingAssert(
      actor.userId === userId,
      "FORBIDDEN",
      "This action requires its assigned trading role",
    );
  }
  async function approvedVersion(tx: Tx, deskId: string, versionId: string) {
    const row = await tx.tradingVersion.findFirst({ where: { id: versionId, deskId } });
    tradingAssert(row, "NOT_FOUND", "Algorithm version not found");
    tradingAssert(
      row.status === "approved",
      "ALGORITHM_NOT_APPROVED",
      "Algorithm version is not enabled",
    );
    tradingAssert(
      row.artifactHash === tradingEngineHash && row.artifact === tradingEngineArtifact,
      "ENGINE_CHANGED",
      "Algorithm engine changed; approve the new version",
    );
    return row;
  }
  async function advanceExecution(
    actor: Actor,
    input: Inputs["reconcileExecution"] | Inputs["cancelSimulation"],
    operation: "reconcile" | "cancel",
    botId?: string,
  ) {
    return change(actor, input.deskId, async (tx, scope, now) => {
      const execution = await tx.tradingExecution.findFirst({
        where: { id: input.executionId, deskId: scope.id },
        include: executionInclude,
      });
      tradingAssert(execution, "NOT_FOUND", "Execution not found");
      const intentRow = await tx.tradingIntent.findUniqueOrThrow({
        where: { id: execution.intentId },
      });
      const record = intentDto(intentRow);
      const current = executionDto(execution);
      if (botId) {
        await checkTradingBot(tx, { ...actor, botId }, scope.id, operation === "cancel");
        if (operation === "cancel")
          tradingAssert(
            record.botId === botId,
            "BOT_MISMATCH",
            "Order belongs to a different executor",
          );
      } else if (operation === "cancel") requireRole(actor, scope.tradeApproverUserId);
      // Tracking submitted orders survives expiry, revocation and version retirement.
      if (operation === "reconcile" && "expectedSequence" in input) {
        tradingAssert(
          input.expectedSequence <= current.receipt.sequence,
          "INVALID_INPUT",
          "Unknown receipt sequence",
        );
        if (input.expectedSequence < current.receipt.sequence) return current;
      }
      if (operation === "cancel" && "clientRequestId" in input) {
        if (execution.events.some((event) => event.clientRequestId === input.clientRequestId))
          return current;
      }
      if (tradingExecutionTerminal(current.receipt.status)) return current;
      if (operation === "cancel")
        await assertBusinessSubmission(
          tx,
          scope.id,
          intentRow.analysisId,
          scope.scope,
          now,
          "cancel",
        );
      if (operation === "cancel" && botId) {
        const grant = execution.grantId
          ? await tx.tradingGrant.findUnique({ where: { id: execution.grantId } })
          : null;
        tradingAssert(
          grant?.allowCancellation && !grant.revokedAt && grant.expiresAt > now,
          "CANCELLATION_NOT_AUTHORIZED",
          "Cancellation requires a separate active authorization",
        );
      }
      const receipt = simulateTradingExecution({
        intent: record.intent,
        executionId: execution.id,
        clientRequestId: execution.clientRequestId,
        scenario: TradingSimulationScenarioSchema.parse(execution.simulationScenario),
        energyStep: record.snapshot.rules.energyStep,
        now,
        previous: current.receipt,
        operation,
        cancellationPending: execution.events.some((event) => event.operation === "cancel"),
      });
      if (receipt === current.receipt) return current;
      if (execution.grantId) {
        const before = tradingExecutionBalance(record.intent, current.receipt);
        const after = tradingExecutionBalance(record.intent, receipt);
        await tx.tradingGrant.update({
          where: { id: execution.grantId },
          data: {
            usedCny: { increment: s(after.settled - before.settled) },
            reservedCny: { increment: s(after.reserved - before.reserved) },
          },
        });
      }
      await tx.tradingExecutionEvent.create({
        data: {
          id: randomUUID(),
          executionId: execution.id,
          sequence: receipt.sequence,
          receipt,
          operation,
          clientRequestId: "clientRequestId" in input ? input.clientRequestId : null,
          createdAt: now,
        },
      });
      await recordBusinessSubmission(
        tx,
        intentRow.analysisId,
        {
          executionId: execution.id,
          intentId: intentRow.id,
          status: receipt.status,
          stage: scope.scope.stage,
          sequence: receipt.sequence,
        },
        now,
      );
      await audit(
        tx,
        actor,
        scope.id,
        operation === "cancel" ? "execution.cancel_requested" : "execution.reconciled",
        execution.id,
        now,
      );
      return executionDto(
        await tx.tradingExecution.findUniqueOrThrow({
          where: { id: execution.id },
          include: executionInclude,
        }),
      );
    });
  }
  return {
    async participants(actor: Actor) {
      const members = await prisma.spaceMember.findMany({
        where: { spaceId: actor.spaceId },
        select: { userId: true, member: { select: { user: { select: { name: true } } } } },
      });
      return members.map((member) => ({ id: member.userId, name: member.member.user.name }));
    },
    bindBot(actor: Actor, input: Inputs["bindBot"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.ownerUserId);
        const bot = await tx.bot.findFirst({
          where: {
            id: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
        });
        tradingAssert(bot, "NOT_FOUND", "Bot not found");
        tradingAssert(
          bot.tradingRole === input.role,
          "SCOPE_MISMATCH",
          "Bot template role cannot be changed by a binding",
        );
        tradingAssert(
          tradingBotSupportsStage(input.role, scope.scope.stage),
          "SCOPE_MISMATCH",
          "Bot role does not match the trading stage",
        );
        const row = await tx.tradingBotBinding.upsert({
          where: { deskId_botId: { deskId: scope.id, botId: bot.id } },
          create: { ...input, createdAt: now },
          update: { role: input.role },
        });
        await ensureTradingLearningPlan(
          tx,
          { id: scope.id, spaceId: scope.spaceId, ownerUserId: scope.ownerUserId },
          bot.id,
          now,
        );
        await audit(tx, actor, scope.id, "bot.bound", bot.id, now);
        return TradingBotBindingSchema.parse(wire(row));
      });
    },
    unbindBot(actor: Actor, input: Inputs["unbindBot"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.ownerUserId);
        const removed = await tx.tradingBotBinding.deleteMany({
          where: { deskId: scope.id, botId: input.botId },
        });
        const plans = await tx.tradingLearningPlan.findMany({
          where: { deskId: scope.id, botId: input.botId },
          select: { routineId: true },
        });
        await tx.routine.updateMany({
          where: { id: { in: plans.map((p) => p.routineId) } },
          data: { active: false, nextRunAt: null },
        });
        if (removed.count) await audit(tx, actor, scope.id, "bot.unbound", input.botId, now);
        return { removed: removed.count > 0 };
      });
    },
    async createDesk(actor: Actor, input: Inputs["createDesk"]) {
      await requireWorkspaceKind(prisma, actor.spaceId, "trading");
      tradingAssert(
        input.scope.environment === "simulation",
        "ENVIRONMENT_MISMATCH",
        "Simulation only",
      );
      const ids = [
        ...new Set([actor.userId, input.algorithmApproverUserId, input.tradeApproverUserId]),
      ];
      const members = await prisma.spaceMember.findMany({
        where: { spaceId: actor.spaceId, userId: { in: ids } },
        select: { userId: true },
      });
      tradingAssert(
        members.length === ids.length,
        "FORBIDDEN",
        "Trading roles must belong to this Space",
      );
      return prisma.$transaction(async (tx) => {
        const now = clock(),
          id = randomUUID();
        const { botId, ...fields } = input;
        const bot = botId
          ? await tx.bot.findFirst({
              where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
            })
          : null;
        const role = bot?.tradingRole ? TradingBotRoleSchema.parse(bot.tradingRole) : null;
        if (botId) {
          tradingAssert(bot && role, "NOT_FOUND", "Trading template Bot not found");
          tradingAssert(
            tradingBotSupportsStage(role, input.scope.stage),
            "SCOPE_MISMATCH",
            "Bot role does not match the trading stage",
          );
        }
        const row = await tx.tradingDesk.create({
          data: {
            id,
            spaceId: actor.spaceId,
            ownerUserId: actor.userId,
            ...fields,
            createdAt: now,
          },
        });
        await groupTradingDesk(tx, row);
        await audit(tx, actor, id, "scope.created", id, now);
        if (bot && role) {
          await tx.tradingBotBinding.create({
            data: { deskId: id, botId: bot.id, role, createdAt: now },
          });
          await ensureTradingLearningPlan(tx, row, bot.id, now);
          await audit(tx, actor, id, "bot.bound", bot.id, now);
        }
        return TradingDeskSchema.parse(wire(row));
      });
    },
    async desks(actor: Actor, input: Inputs["desks"] = {}) {
      if (input.botId) {
        const bot = await prisma.bot.findFirst({
          where: {
            id: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
        });
        tradingAssert(bot, "NOT_FOUND", "Bot not found");
      }
      const rows = await prisma.tradingDesk.findMany({
        where: {
          spaceId: actor.spaceId,
          ...(input.botId ? { bindings: { some: { botId: input.botId } } } : {}),
          OR: [
            { ownerUserId: actor.userId },
            { algorithmApproverUserId: actor.userId },
            { tradeApproverUserId: actor.userId },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
      });
      return rows.map((row) => TradingDeskSchema.parse(wire(row)));
    },
    async desk(actor: Actor, input: Inputs["desk"]) {
      const scope = await desk(prisma, actor, input.deskId);
      const query = {
        where: { deskId: scope.id },
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: 100,
      };
      const [versions, intents, grants, executions, events, bindings] = await Promise.all([
        prisma.tradingVersion.findMany(query),
        prisma.tradingIntent.findMany(query),
        prisma.tradingGrant.findMany(query),
        prisma.tradingExecution.findMany({ ...query, include: executionInclude }),
        prisma.tradingAudit.findMany(query),
        prisma.tradingBotBinding.findMany({
          where: { deskId: scope.id },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      ]);
      return {
        desk: scope,
        simulationScenario: TradingSimulationScenarioSchema.parse(
          (await prisma.tradingSimulationPolicy.findUnique({ where: { deskId: scope.id } }))
            ?.scenario ?? "immediate_fill",
        ),
        versions: versions.map(versionDto),
        intents: intents.map(intentDto),
        grants: grants.map(grantDto),
        executions: executions.map(executionDto),
        audit: events.map((row) => TradingAuditSchema.parse(wire(row))),
        bindings: bindings.map((row) => TradingBotBindingSchema.parse(wire(row))),
      };
    },
    async prepareIntent(actor: Actor, input: Inputs["prepareIntent"], botId?: string) {
      const analysis = await analyses.get(actor, input.analysisId);
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.ownerUserId);
        if (botId) await checkTradingBot(tx, { ...actor, botId }, scope.id, true);
        tradingAssert(
          same(analysis.snapshot.scope, scope.scope),
          "SCOPE_MISMATCH",
          "Analysis belongs to another business scope",
        );
        const snapshot = validateTradingSnapshot(analysis.snapshot, now);
        await assertBusinessSubmission(tx, scope.id, analysis.id, scope.scope, now, "prepare");
        const algorithmVersionId = tradingAlgorithmIdentity(
          scope.scope.subjectKind,
          analysis.parameters,
        );
        tradingAssert(
          analysis.decision.algorithmVersionId === algorithmVersionId,
          "ENGINE_CHANGED",
          "Recompute the analysis with the current engine",
        );
        const decision = runTradingBaseline(snapshot, algorithmVersionId, analysis.parameters, now);
        tradingAssert(
          same(decision, analysis.decision),
          "INTENT_CHANGED",
          "Analysis integrity check failed",
        );
        tradingAssert(
          Date.parse(input.expiresAt) > now.getTime() &&
            Date.parse(input.expiresAt) <=
              Math.min(
                Date.parse(snapshot.source.validUntil),
                Date.parse(snapshot.rules.source.validUntil),
              ),
          "EXPIRED",
          "Intent expiry must fit within the source validity",
        );
        const unsigned = {
          intentId: randomUUID(),
          scope: scope.scope,
          algorithmVersionId,
          snapshotId: snapshot.snapshotId,
          ruleVersion: snapshot.rules.version,
          lines: decision.lines,
          expiresAt: input.expiresAt,
        };
        tradingAssert(
          decision.lines.length > 0 && decision.lines.length <= 2000,
          "RISK_REJECTED",
          "Executable intents require between 1 and 2000 order lines",
        );
        const intent = TradingIntentSchema.parse({ ...unsigned, intentHash: digest(unsigned) });
        const record = {
          botId: botId ?? null,
          id: intent.intentId,
          deskId: scope.id,
          versionId: "pending",
          analysisId: analysis.id,
          intent,
          snapshot,
          parameters: analysis.parameters,
          grossNotionalCny: decision.grossNotionalCny,
          approvedByUserId: null,
          approvedAt: null,
          createdAt: now.toISOString(),
        };
        checkIntent(record, now);
        const version = await tx.tradingVersion.upsert({
          where: { deskId_algorithmVersionId: { deskId: scope.id, algorithmVersionId } },
          update: {},
          create: {
            id: randomUUID(),
            deskId: scope.id,
            algorithmVersionId,
            artifactHash: tradingEngineHash,
            artifact: tradingEngineArtifact,
            parameters: analysis.parameters,
            validation: {
              kind: "deterministic_constraints",
              analysisId: analysis.id,
              decisionHash: digest(decision),
            },
            createdAt: now,
          },
        });
        tradingAssert(
          version.status !== "retired",
          "ALGORITHM_RETIRED",
          "Algorithm version retired",
        );
        const row = await tx.tradingIntent.create({
          data: {
            botId: botId ?? null,
            id: intent.intentId,
            deskId: scope.id,
            versionId: version.id,
            analysisId: analysis.id,
            intent,
            snapshot,
            parameters: analysis.parameters,
            grossNotionalCny: decision.grossNotionalCny,
            createdAt: now,
          },
        });
        await audit(tx, actor, scope.id, "intent.prepared", row.id, now);
        return intentDto(row);
      });
    },
    approveAlgorithm(actor: Actor, input: Inputs["approveAlgorithm"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.algorithmApproverUserId);
        const version = await tx.tradingVersion.findFirst({
          where: { id: input.versionId, deskId: scope.id },
        });
        tradingAssert(version, "NOT_FOUND", "Algorithm version not found");
        tradingAssert(
          version.status !== "retired",
          "ALGORITHM_RETIRED",
          "Algorithm version retired",
        );
        tradingAssert(
          version.artifactHash === input.expectedArtifactHash &&
            version.artifactHash === tradingEngineHash &&
            version.artifact === tradingEngineArtifact,
          "ENGINE_CHANGED",
          "Algorithm artifact changed",
        );
        if (version.status === "approved") return versionDto(version);
        const row = await tx.tradingVersion.update({
          where: { id: version.id },
          data: { status: "approved", approvedByUserId: actor.userId, approvedAt: now },
        });
        await audit(tx, actor, scope.id, "algorithm.approved", version.id, now);
        return versionDto(row);
      });
    },
    retireAlgorithm(actor: Actor, input: Inputs["retireAlgorithm"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.algorithmApproverUserId);
        const version = await tx.tradingVersion.findFirst({
          where: { id: input.versionId, deskId: scope.id },
        });
        tradingAssert(version, "NOT_FOUND", "Algorithm version not found");
        if (version.status === "retired") return versionDto(version);
        const row = await tx.tradingVersion.update({
          where: { id: version.id },
          data: { status: "retired" },
        });
        await audit(tx, actor, scope.id, "algorithm.retired", version.id, now);
        return versionDto(row);
      });
    },
    approveIntent(actor: Actor, input: Inputs["approveIntent"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.tradeApproverUserId);
        const row = await tx.tradingIntent.findFirst({
          where: { id: input.intentId, deskId: scope.id },
        });
        tradingAssert(row, "NOT_FOUND", "Intent not found");
        const record = intentDto(row);
        tradingAssert(
          record.intent.intentHash === input.expectedIntentHash,
          "INTENT_CHANGED",
          "Approval refers to different intent content",
        );
        checkIntent(record, now);
        if (row.approvedAt) return record;
        const approved = await tx.tradingIntent.update({
          where: { id: row.id },
          data: { approvedByUserId: actor.userId, approvedAt: now },
        });
        await audit(tx, actor, scope.id, "intent.approved", row.id, now);
        return intentDto(approved);
      });
    },
    createGrant(actor: Actor, input: Inputs["createGrant"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.tradeApproverUserId);
        await approvedVersion(tx, scope.id, input.versionId);
        if (input.botId)
          await checkTradingBot(
            tx,
            { userId: scope.ownerUserId, spaceId: scope.spaceId, botId: input.botId },
            scope.id,
            true,
          );
        tradingAssert(
          d(input.perTradeLimitCny) > 0n &&
            d(input.cumulativeLimitCny) >= d(input.perTradeLimitCny),
          "INVALID_INPUT",
          "Invalid grant limits",
        );
        tradingAssert(
          Date.parse(input.expiresAt) > now.getTime(),
          "EXPIRED",
          "Grant expiry must be in the future",
        );
        const row = await tx.tradingGrant.create({
          data: {
            botId: input.botId ?? null,
            id: randomUUID(),
            deskId: scope.id,
            versionId: input.versionId,
            perTradeLimitCny: input.perTradeLimitCny,
            cumulativeLimitCny: input.cumulativeLimitCny,
            allowCancellation: input.allowCancellation ?? false,
            expiresAt: new Date(input.expiresAt),
            approvedByUserId: actor.userId,
            createdAt: now,
          },
        });
        await audit(tx, actor, scope.id, "grant.created", row.id, now);
        return grantDto(row);
      });
    },
    revokeGrant(actor: Actor, input: Inputs["revokeGrant"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.tradeApproverUserId);
        const grant = await tx.tradingGrant.findFirst({
          where: { id: input.grantId, deskId: scope.id },
        });
        tradingAssert(grant, "NOT_FOUND", "Grant not found");
        if (grant.revokedAt) return grantDto(grant);
        const row = await tx.tradingGrant.update({
          where: { id: grant.id },
          data: { revokedAt: now },
        });
        await audit(tx, actor, scope.id, "grant.revoked", grant.id, now);
        return grantDto(row);
      });
    },
    executeSimulation(actor: Actor, input: Inputs["executeSimulation"], botId?: string) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.ownerUserId);
        if (botId) await checkTradingBot(tx, { ...actor, botId }, scope.id, true);
        const requestHash = digest(input);
        const prior = await tx.tradingExecution.findFirst({
          where: { deskId: scope.id, clientRequestId: input.clientRequestId },
          include: executionInclude,
        });
        if (prior) {
          const executor = await tx.tradingIntent.findUniqueOrThrow({
            where: { id: prior.intentId },
            select: { botId: true },
          });
          tradingAssert(
            executor.botId === (botId ?? null),
            "BOT_MISMATCH",
            "Intent belongs to a different executor",
          );
          tradingAssert(
            prior.requestHash === requestHash,
            "IDEMPOTENCY_CONFLICT",
            "Request ID already used with different content",
          );
          return executionDto(prior);
        }
        const row = await tx.tradingIntent.findFirst({
          where: { id: input.intentId, deskId: scope.id },
        });
        tradingAssert(row, "NOT_FOUND", "Intent not found");
        const record = intentDto(row);
        tradingAssert(
          record.botId === (botId ?? null),
          "BOT_MISMATCH",
          "Intent belongs to a different executor",
        );
        tradingAssert(
          record.intent.intentHash === input.expectedIntentHash,
          "INTENT_CHANGED",
          "Execution refers to different intent content",
        );
        const previousIntent = await tx.tradingExecution.findFirst({ where: { intentId: row.id } });
        tradingAssert(
          !previousIntent,
          "ALREADY_SUBMITTED",
          "Intent already executed; query its original request",
        );
        checkIntent(record, now);
        await assertBusinessSubmission(tx, scope.id, row.analysisId, scope.scope, now);
        const version = await approvedVersion(tx, scope.id, row.versionId);
        tradingAssert(
          version.algorithmVersionId === record.intent.algorithmVersionId &&
            same(version.parameters, record.parameters),
          "ENGINE_CHANGED",
          "Intent does not match the enabled algorithm version",
        );
        if (input.grantId) {
          const grant = await tx.tradingGrant.findFirst({
            where: { id: input.grantId, deskId: scope.id, versionId: row.versionId },
          });
          tradingAssert(grant, "GRANT_MISMATCH", "Grant does not cover this scope and version");
          tradingAssert(
            grant.botId === (botId ?? null),
            "GRANT_MISMATCH",
            "Grant belongs to a different executor",
          );
          tradingAssert(
            !grant.revokedAt && grant.expiresAt > now,
            "GRANT_INACTIVE",
            "Grant revoked or expired",
          );
          const amount = d(record.grossNotionalCny),
            used = d(grant.usedCny.toFixed());
          tradingAssert(
            amount <= d(grant.perTradeLimitCny.toFixed()),
            "PER_TRADE_LIMIT",
            "Single trade limit exceeded",
          );
          tradingAssert(
            used + d(grant.reservedCny.toFixed()) + amount <= d(grant.cumulativeLimitCny.toFixed()),
            "CUMULATIVE_LIMIT",
            "Cumulative limit exceeded",
          );
          await tx.tradingGrant.update({
            where: { id: grant.id },
            data: { reservedCny: { increment: s(amount) } },
          });
        } else {
          tradingAssert(
            row.approvedAt && row.approvedByUserId === scope.tradeApproverUserId,
            "TRADE_NOT_APPROVED",
            "Trade requires single intent approval or a bounded grant",
          );
        }
        const id = randomUUID();
        const scenario = TradingSimulationScenarioSchema.parse(
          (await tx.tradingSimulationPolicy.findUnique({ where: { deskId: scope.id } }))
            ?.scenario ?? "immediate_fill",
        );
        const receipt = simulateTradingExecution({
          intent: record.intent,
          executionId: id,
          clientRequestId: input.clientRequestId,
          scenario,
          energyStep: record.snapshot.rules.energyStep,
          now,
        });
        if (input.grantId) {
          const balance = tradingExecutionBalance(record.intent, receipt);
          await tx.tradingGrant.update({
            where: { id: input.grantId },
            data: {
              usedCny: { increment: s(balance.settled) },
              reservedCny: { increment: s(balance.reserved - d(record.grossNotionalCny)) },
            },
          });
        }
        const execution = await tx.tradingExecution.create({
          data: {
            id,
            deskId: scope.id,
            intentId: row.id,
            grantId: input.grantId ?? null,
            clientRequestId: input.clientRequestId,
            requestHash,
            receipt,
            simulationScenario: scenario,
            createdAt: now,
          },
        });
        await recordBusinessSubmission(
          tx,
          row.analysisId,
          {
            executionId: id,
            intentId: row.id,
            status: receipt.status,
            stage: scope.scope.stage,
            sequence: receipt.sequence,
          },
          now,
        );
        await audit(tx, actor, scope.id, "execution.simulated", id, now);
        return executionDto({ ...execution, events: [] });
      });
    },
    configureSimulation(actor: Actor, input: Inputs["configureSimulation"]) {
      return change(actor, input.deskId, async (tx, scope, now) => {
        requireRole(actor, scope.ownerUserId);
        await tx.tradingSimulationPolicy.upsert({
          where: { deskId: scope.id },
          create: { deskId: scope.id, scenario: input.scenario },
          update: { scenario: input.scenario },
        });
        await audit(tx, actor, scope.id, `simulation.configured.${input.scenario}`, scope.id, now);
        return { scenario: input.scenario };
      });
    },
    reconcileExecution(actor: Actor, input: Inputs["reconcileExecution"], botId?: string) {
      return advanceExecution(actor, input, "reconcile", botId);
    },
    cancelSimulation(actor: Actor, input: Inputs["cancelSimulation"], botId?: string) {
      return advanceExecution(actor, input, "cancel", botId);
    },
    async executionByRequest(actor: Actor, input: Inputs["executionByRequest"]) {
      await desk(prisma, actor, input.deskId);
      const row = await prisma.tradingExecution.findFirst({
        where: { deskId: input.deskId, clientRequestId: input.clientRequestId },
        include: executionInclude,
      });
      tradingAssert(row, "NOT_FOUND", "Execution not found");
      return executionDto(row);
    },
  };
}

import { randomUUID } from "node:crypto";
import type { Actor, BusinessEvidence, BusinessImportInput, TradingScope } from "@rakazo/contracts";
import {
  BusinessCycleSchema,
  BusinessEvidenceSchema,
  BusinessImportInputSchema,
  BusinessMarketRuleSchema,
  TradingIntentSchema,
} from "@rakazo/contracts";
import {
  businessEvidenceBlockers,
  businessSubmissionStream,
  currentBusinessEvidence,
  tradingDecimal as d,
  tradingAssert,
} from "@rakazo/core";
import type { BusinessCycle, Prisma, PrismaClient } from "./client.js";
import { currentDbContext } from "./row-security.js";
import { tradingCanonical, tradingDigest } from "./trading-engine.js";
import { requireIsolatedBot, requireWorkspaceKind } from "./workspace-isolation.js";

export type BusinessIdentity = Pick<Actor, "spaceId" | "userId"> & { botId?: string };
export type CycleDb = Prisma.TransactionClient | PrismaClient;
export const cycleDto = (row: BusinessCycle) =>
  BusinessCycleSchema.parse({
    ...row,
    start: row.start.toISOString(),
    end: row.end.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
export async function businessIdentity(db: CycleDb, identity: BusinessIdentity) {
  await requireWorkspaceKind(db, identity.spaceId, "trading");
  const workspace = await db.tradingWorkspace.findFirst({
    where: {
      spaceId: identity.spaceId,
      ownerUserId: identity.userId,
      space: { memberships: { some: { userId: identity.userId } } },
    },
  });
  tradingAssert(workspace, "FORBIDDEN", "Business workspace is not available to this identity");
  const bot = identity.botId
    ? await requireIsolatedBot(db, { ...identity, botId: identity.botId })
    : null;
  tradingAssert(
    !bot || bot.businessSupervisor || bot.tradingRole,
    "FORBIDDEN",
    "Business evidence is not available to general Bots",
  );
  return { workspace, bot };
}

/** After locking the cycle, hold live authority through the result transaction's commit. */
export async function lockBusinessResultIdentity(
  db: Prisma.TransactionClient,
  identity: BusinessIdentity,
) {
  // Shared row locks allow other cycles to proceed, but serialize membership removal,
  // workspace deletion/ownership changes and Bot archival against this write.
  await db.$queryRaw`
    SELECT s.id FROM spaces s
    JOIN space_members m ON m."spaceId" = s.id AND m."userId" = ${identity.userId}
    JOIN trading_workspaces w ON w."spaceId" = s.id AND w."ownerUserId" = ${identity.userId}
    WHERE s.id = ${identity.spaceId}
    FOR SHARE OF s, m, w
  `;
  if (identity.botId)
    await db.$queryRaw`
      SELECT id FROM bots WHERE id = ${identity.botId}
      AND "spaceId" = ${identity.spaceId} AND "userId" = ${identity.userId}
      FOR SHARE
    `;
  // ownedCycle's initial authorization may predate a lock wait. Never reuse it.
  return businessIdentity(db, identity);
}
export async function ownedCycle(
  db: CycleDb,
  identity: BusinessIdentity,
  cycleId: string,
  lock = false,
) {
  const access = await businessIdentity(db, identity);
  const cycle = await db.businessCycle.findFirst({
    where: { id: cycleId, workspaceId: access.workspace.id },
  });
  tradingAssert(cycle, "NOT_FOUND", "Business cycle not found");
  if (lock) await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${cycleId} FOR UPDATE`;
  return { ...access, cycle };
}
export async function cycleEvidence(db: CycleDb, cycleId: string): Promise<BusinessEvidence[]> {
  const rows = await db.businessEvidence.findMany({
    where: { cycleId },
    orderBy: [{ receivedAt: "asc" }, { revision: "asc" }, { id: "asc" }],
  });
  return rows.map((row) =>
    BusinessEvidenceSchema.parse({ ...row, receivedAt: row.receivedAt.toISOString() }),
  );
}

/** Call with this cycle locked. Idempotency is content-based, corrections append a new head. */
export async function appendBusinessEvidence(
  db: CycleDb,
  cycleId: string,
  input: Omit<
    BusinessEvidence,
    | "id"
    | "cycleId"
    | "revision"
    | "receivedAt"
    | "contentHash"
    | "recordedByUserId"
    | "recordedByBotId"
  >,
  now: Date,
  botId?: string,
) {
  const context = currentDbContext();
  tradingAssert(
    context?.kind === "tenant",
    "FORBIDDEN",
    "Business evidence requires a tenant identity",
  );
  const contentHash = tradingDigest(tradingCanonical(input));
  const prior = await db.businessEvidence.findUnique({
    where: {
      cycleId_source_sourceRecordId: {
        cycleId,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
      },
    },
  });
  if (prior) {
    tradingAssert(
      prior.contentHash === contentHash,
      "IDEMPOTENCY_CONFLICT",
      "Source record already exists with different content",
    );
    return BusinessEvidenceSchema.parse({ ...prior, receivedAt: prior.receivedAt.toISOString() });
  }
  const head = await db.businessEvidence.findFirst({
    where: { cycleId, streamKey: input.streamKey },
    orderBy: { revision: "desc" },
  });
  tradingAssert(
    (head?.id ?? null) === input.supersedesId,
    "VERSION_CONFLICT",
    "A correction must name the latest evidence version",
  );
  const refs = await db.businessEvidence.findMany({
    where: { cycleId, id: { in: input.references } },
    select: { id: true },
  });
  tradingAssert(
    refs.length === new Set(input.references).size,
    "FORBIDDEN",
    "Evidence references must belong to this business cycle",
  );
  const row = await db.businessEvidence.create({
    data: {
      ...input,
      recordedByUserId: context.userId,
      recordedByBotId: botId ?? null,
      id: randomUUID(),
      cycleId,
      revision: (head?.revision ?? 0) + 1,
      receivedAt: now,
      contentHash,
      data: input.data as Prisma.InputJsonObject,
    },
  });
  return BusinessEvidenceSchema.parse({ ...row, receivedAt: row.receivedAt.toISOString() });
}

export async function importBusinessEvidence(
  db: CycleDb,
  cycle: BusinessCycle,
  raw: BusinessImportInput,
  now: Date,
) {
  const input = BusinessImportInputSchema.parse(raw),
    data = input.data;
  if ("intervals" in data)
    for (const row of data.intervals) {
      row.start = new Date(row.start).toISOString();
      row.end = new Date(row.end).toISOString();
    }
  const rule = BusinessMarketRuleSchema.parse(cycle.rule);
  if ("intervals" in data) {
    const intervals = data.intervals;
    const keys = new Set<string>();
    for (const row of intervals) {
      tradingAssert(
        Date.parse(row.start) >= cycle.start.getTime() &&
          Date.parse(row.end) <= cycle.end.getTime() &&
          Date.parse(row.start) < Date.parse(row.end),
        "INVALID_INPUT",
        "Evidence interval is outside this cycle",
      );
      const key = `${row.start}/${row.end}`;
      tradingAssert(
        data.kind === "contracts" || !keys.has(key),
        "INVALID_INPUT",
        "Duplicate evidence interval",
      );
      keys.add(key);
      if ("referencePoint" in row)
        tradingAssert(
          row.referencePoint === rule.referencePoint,
          "REFERENCE_MISMATCH",
          "Unmapped settlement reference point",
        );
      if (data.kind === "asset" && "availableEnergyMwh" in row)
        tradingAssert(
          d(row.otherPhysicalCommitmentMwh) <= d(row.availableEnergyMwh),
          "RISK_REJECTED",
          "Physical commitments exceed available energy",
        );
    }
    const periods = [...new Map(intervals.map((r) => [`${r.start}/${r.end}`, r])).values()].sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start),
    );
    tradingAssert(
      Date.parse(periods[0]!.start) === cycle.start.getTime() &&
        Date.parse(periods.at(-1)!.end) === cycle.end.getTime() &&
        periods.every((r, i) => i === 0 || Date.parse(periods[i - 1]!.end) === Date.parse(r.start)),
      "MISSING_EVIDENCE",
      "Evidence must cover the full cycle without gaps or overlaps",
    );
  }
  const existing = await cycleEvidence(db, cycle.id);
  const current = currentBusinessEvidence(existing);
  const requireRef = (key: string) => {
    const row = current.find((r) => r.streamKey === key && r.status === "confirmed");
    tradingAssert(
      row && input.references.includes(row.id),
      "MISSING_EVIDENCE",
      `Reference required: ${key}`,
    );
    return row;
  };
  if (data.kind === "clearing") {
    if (data.stage === "day_ahead") {
      const receipt = requireRef("submission");
      tradingAssert(
        ["accepted", "filled", "partially_filled"].includes(String(receipt.data.status)),
        "MISSING_EVIDENCE",
        "An accepted submission is required",
      );
      const execution = await db.tradingExecution.findUnique({
        where: { id: String(receipt.data.executionId) },
        include: { intent: true },
      });
      tradingAssert(
        execution,
        "MISSING_EVIDENCE",
        "Submission evidence has no persisted execution",
      );
      const intent = TradingIntentSchema.parse(execution.intent.intent);
      tradingAssert(
        intent.scope.stage === "day_ahead",
        "STAGE_NOT_SUPPORTED",
        "Day-ahead clearing requires a day-ahead submission",
      );
      for (const interval of data.intervals) {
        const submitted = intent.lines
          .filter((line) => line.start === interval.start && line.end === interval.end)
          .reduce((sum, line) => sum + d(line.energyMwh), 0n);
        tradingAssert(
          d(interval.energyMwh) <= submitted,
          "RISK_REJECTED",
          "Clearing exceeds the submitted quantity",
        );
      }
    } else requireRef("clearing:day_ahead");
  }
  if (data.kind === "delivery") requireRef("clearing:day_ahead");
  if (data.kind === "metering") requireRef("delivery");
  if (data.kind === "bill") {
    requireRef("clearing:realtime");
    const meter = current.find((r) => r.streamKey === "metering");
    tradingAssert(
      meter && input.references.includes(meter.id),
      "MISSING_EVIDENCE",
      "Metering reference required",
    );
  }
  return appendBusinessEvidence(
    db,
    cycle.id,
    {
      streamKey: data.kind === "clearing" ? `clearing:${data.stage}` : data.kind,
      supersedesId: input.supersedesId ?? null,
      kind: data.kind,
      origin: "synthetic",
      status: input.status,
      source: input.source,
      sourceRecordId: input.sourceRecordId,
      references: input.references,
      data,
    },
    now,
  );
}

/** Existing preparation/execution paths enforce these rules too; an unlinked legacy analysis cannot bypass a configured cycle. */
export async function assertBusinessSubmission(
  db: CycleDb,
  deskId: string,
  analysisId: string,
  scope: TradingScope,
  now: Date,
  action: "submit" | "prepare" | "cancel" = "submit",
) {
  const deskLink = await db.tradingWorkspaceDesk.findUnique({ where: { deskId } });
  if (!deskLink) return null;
  const configured = await db.businessCycle.count({ where: { workspaceId: deskLink.workspaceId } });
  if (!configured) return null;
  const analysis = await db.businessCycleAnalysis.findUnique({ where: { analysisId } });
  const cycle = analysis
    ? await db.businessCycle.findFirst({
        where: { id: analysis.cycleId, workspaceId: deskLink.workspaceId },
      })
    : null;
  tradingAssert(
    cycle && analysis,
    "MISSING_EVIDENCE",
    "Use an analysis linked to this business cycle",
  );
  await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${cycle.id} FOR UPDATE`;
  const rule = BusinessMarketRuleSchema.parse(cycle.rule);
  const stage = rule.stages.find((row) => row.stage === scope.stage);
  tradingAssert(
    scope.environment === "simulation" && rule.subjectKinds.includes(scope.subjectKind),
    "FORBIDDEN",
    "Subject is not eligible under this simulated rule",
  );
  tradingAssert(
    stage?.mode === "quantity_price",
    "STAGE_NOT_SUPPORTED",
    "This phase only accepts results or is closed to submissions",
  );
  tradingAssert(
    Date.parse(stage.opensAt) <= now.getTime() && Date.parse(stage.closesAt) > now.getTime(),
    "MARKET_CLOSED",
    "Submission window is closed",
  );
  tradingAssert(
    action !== "cancel" || stage.allowCancellation,
    "MARKET_CLOSED",
    "Cancellation is not allowed by this rule",
  );
  const evidence = await cycleEvidence(db, cycle.id),
    current = currentBusinessEvidence(evidence);
  tradingAssert(
    analysis.ruleVersion === rule.version &&
      Array.isArray(analysis.evidenceIds) &&
      analysis.evidenceIds.every((id) => current.some((row) => row.id === id)),
    "STALE_DATA",
    "Analysis evidence has changed; recompute before submitting",
  );
  tradingAssert(
    businessEvidenceBlockers(evidence, stage.requires, true).length === 0,
    "MISSING_EVIDENCE",
    "Previous market evidence is not ready",
  );
  if (!stage.allowRevision && action !== "cancel")
    tradingAssert(
      !evidence.some((row) => row.kind === "submission" && row.data.stage === scope.stage),
      "REVISION_FORBIDDEN",
      "A prior submission is sealed; this rule does not allow re-submission",
    );
  return cycle;
}

export async function recordBusinessSubmission(
  db: CycleDb,
  analysisId: string,
  data: { executionId: string; intentId: string; status: string; stage: string; sequence: number },
  now: Date,
) {
  const link = await db.businessCycleAnalysis.findUnique({ where: { analysisId } });
  if (!link) return;
  await db.$queryRaw`SELECT id FROM business_cycles WHERE id=${link.cycleId} FOR UPDATE`;
  const source = "simulated-submission-service",
    sourceRecordId = `${data.executionId}:${data.sequence}`;
  const payload = {
    ...data,
    analysisId,
    evidenceIds: link.evidenceIds,
    ruleVersion: link.ruleVersion,
  };
  const prior = await db.businessEvidence.findUnique({
    where: { cycleId_source_sourceRecordId: { cycleId: link.cycleId, source, sourceRecordId } },
  });
  if (prior) {
    tradingAssert(
      tradingCanonical(prior.data) === tradingCanonical(payload),
      "IDEMPOTENCY_CONFLICT",
      "Submission receipt already exists with different content",
    );
    return;
  }
  const streamKey = businessSubmissionStream(data.stage);
  const head = await db.businessEvidence.findFirst({
    where: { cycleId: link.cycleId, streamKey },
    orderBy: { revision: "desc" },
  });
  await appendBusinessEvidence(
    db,
    link.cycleId,
    {
      streamKey,
      supersedesId: head?.id ?? null,
      kind: "submission",
      status: "confirmed",
      origin: "synthetic",
      source,
      sourceRecordId,
      references: [],
      data: payload,
    },
    now,
  );
}

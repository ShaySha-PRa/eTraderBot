import { randomUUID } from "node:crypto";
import type { SecretRecord } from "@rakazo/adapter-kit";
import type { Actor, RpcInput, TradingWorkspace } from "@rakazo/contracts";
import {
  TradingBotRoleSchema,
  TradingInterfaceSchema,
  TradingWorkspaceSchema,
  TradingWorkspaceScopeSchema,
} from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { createSpaceForMember, lockSpaceForContentCreation } from "./spaces.js";
import { tradingCanonical } from "./trading-engine.js";
import { ensureTradingLearningPlan } from "./trading-learning.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Tx = Prisma.TransactionClient;
const include = {
  space: { select: { name: true, bots: { where: { archivedAt: null }, select: { id: true } } } },
  desks: { include: { desk: { include: { bindings: true } } } },
} as const;
type Row = Prisma.TradingWorkspaceGetPayload<{ include: typeof include }>;
function dto(row: Row): TradingWorkspace {
  const { desks, space, ...workspace } = row;
  return TradingWorkspaceSchema.parse({
    ...workspace,
    name: space.name,
    createdAt: row.createdAt.toISOString(),
    deskIds: desks.map((link) => link.deskId),
    botIds: space.bots.map((bot) => bot.id),
  });
}
function interfaceDto(row: Prisma.TradingWorkspaceInterfaceGetPayload<object>) {
  const { secretId, ...record } = row;
  return TradingInterfaceSchema.parse({
    ...record,
    updatedAt: row.updatedAt.toISOString(),
    hasSecret: Boolean(secretId),
    status: "configured",
  });
}
async function access(db: Tx | PrismaClient, actor: Actor, id: string, write = false) {
  const row = await db.tradingWorkspace.findFirst({
    where: {
      id,
      spaceId: actor.spaceId,
      ...(write
        ? { ownerUserId: actor.userId }
        : {
            OR: [
              { ownerUserId: actor.userId },
              { algorithmApproverUserId: actor.userId },
              { tradeApproverUserId: actor.userId },
            ],
          }),
    },
  });
  tradingAssert(row, "NOT_FOUND", "Business scope not found");
  return row;
}

/** Caller owns the transaction, including Bot creation; no partial membership on failure. */
export async function connectTradingWorkspaceBot(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  botId: string,
  now = new Date(),
) {
  await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  const workspace = await access(tx, actor, workspaceId, true);
  const bot = await tx.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
  });
  tradingAssert(bot?.tradingRole, "NOT_FOUND", "Trading template Bot not found");
  const role = TradingBotRoleSchema.parse(bot.tradingRole);
  const stages =
    role === "mid_long_term"
      ? ["mid_long_term"]
      : role === "spot"
        ? ["day_ahead", "intraday", "realtime"]
        : ["mid_long_term", "day_ahead", "intraday", "realtime"];
  const scope = TradingWorkspaceScopeSchema.parse(workspace.scope);
  const links = await tx.tradingWorkspaceDesk.findMany({
    where: { workspaceId },
    include: { desk: true },
    orderBy: { deskId: "asc" },
  });
  const deskIds: string[] = [];
  for (const stage of stages) {
    let desk = links.find((link) => (link.desk.scope as { stage?: string }).stage === stage)?.desk;
    if (!desk) {
      desk = await tx.tradingDesk.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          ownerUserId: actor.userId,
          algorithmApproverUserId: workspace.algorithmApproverUserId,
          tradeApproverUserId: workspace.tradeApproverUserId,
          scope: { ...scope, stage },
          createdAt: now,
        },
      });
      await tx.tradingWorkspaceDesk.create({ data: { workspaceId, deskId: desk.id } });
      await tx.tradingAudit.create({
        data: {
          id: randomUUID(),
          deskId: desk.id,
          actorUserId: actor.userId,
          kind: "scope.created",
          recordId: desk.id,
          createdAt: now,
        },
      });
    }
    const bound = await tx.tradingBotBinding.findUnique({
      where: { deskId_botId: { deskId: desk.id, botId } },
    });
    tradingAssert(
      !bound || bound.role === role,
      "SCOPE_MISMATCH",
      "Existing Bot role does not match its template",
    );
    if (!bound) {
      await tx.tradingBotBinding.create({ data: { deskId: desk.id, botId, role, createdAt: now } });
      await tx.tradingAudit.create({
        data: {
          id: randomUUID(),
          deskId: desk.id,
          actorUserId: actor.userId,
          kind: "bot.bound",
          recordId: botId,
          createdAt: now,
        },
      });
    }
    await ensureTradingLearningPlan(tx, desk, botId, now);
    deskIds.push(desk.id);
  }
  return { deskIds };
}

/** Existing stage callers join the current business; no new grouping or authorization boundary. */
export async function groupTradingDesk(tx: Tx, desk: Prisma.TradingDeskGetPayload<object>) {
  const { stage: _stage, ...scope } = desk.scope as Record<string, Prisma.JsonValue>;
  await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${desk.spaceId} FOR UPDATE`;
  let row = await tx.tradingWorkspace.findFirst({ where: { spaceId: desk.spaceId } });
  if (row) {
    tradingAssert(
      tradingCanonical(row.scope) === tradingCanonical(scope) &&
        row.ownerUserId === desk.ownerUserId &&
        row.algorithmApproverUserId === desk.algorithmApproverUserId &&
        row.tradeApproverUserId === desk.tradeApproverUserId,
      "SCOPE_MISMATCH",
      "Create another business scope for a different account or approval policy",
    );
  } else {
    const space = await tx.space.findUniqueOrThrow({ where: { id: desk.spaceId } });
    row = await tx.tradingWorkspace.create({
      data: {
        id: randomUUID(),
        name: space.name,
        scope,
        spaceId: desk.spaceId,
        ownerUserId: desk.ownerUserId,
        algorithmApproverUserId: desk.algorithmApproverUserId,
        tradeApproverUserId: desk.tradeApproverUserId,
        createdAt: desk.createdAt,
      },
    });
  }
  await tx.tradingWorkspaceDesk.create({ data: { workspaceId: row.id, deskId: desk.id } });
}

async function configure(
  tx: Tx,
  actor: Actor,
  input: RpcInput<"trading/createWorkspace">,
  now: Date,
) {
  await lockSpaceForContentCreation(tx, { spaceId: actor.spaceId, userId: actor.userId });
  await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  tradingAssert(
    membership?.role === "owner",
    "FORBIDDEN",
    "Only the business owner can configure it",
  );
  const ids = [
    ...new Set([actor.userId, input.algorithmApproverUserId, input.tradeApproverUserId]),
  ];
  const members = await tx.spaceMember.count({
    where: { spaceId: actor.spaceId, userId: { in: ids } },
  });
  tradingAssert(
    members === ids.length,
    "FORBIDDEN",
    "Approvers must belong to this business scope",
  );
  const existing = await tx.tradingWorkspace.findFirst({
    where: { spaceId: actor.spaceId },
    include,
  });
  if (existing) {
    tradingAssert(
      existing.ownerUserId === actor.userId &&
        (!input.id || existing.id === input.id) &&
        existing.algorithmApproverUserId === input.algorithmApproverUserId &&
        existing.tradeApproverUserId === input.tradeApproverUserId &&
        tradingCanonical(existing.scope) === tradingCanonical(input.scope),
      "SCOPE_MISMATCH",
      "This business scope is already configured; create a new business scope for another account",
    );
    return dto(existing);
  }
  // The Space name is canonical; settings cannot rename an existing business implicitly.
  const space = await tx.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
  const row = await tx.tradingWorkspace.create({
    data: {
      ...input,
      id: input.id ?? randomUUID(),
      name: space.name,
      spaceId: actor.spaceId,
      ownerUserId: actor.userId,
      createdAt: now,
    },
    include,
  });
  return dto(row);
}

export function createTradingWorkspaceService(prisma: PrismaClient, clock = () => new Date()) {
  async function change<T>(actor: Actor, id: string, action: (tx: Tx) => Promise<T>) {
    return withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE id = ${id} FOR UPDATE`;
        await access(tx, actor, id, true);
        return action(tx);
      }),
    );
  }
  return {
    async list(actor: Actor) {
      const rows = await prisma.tradingWorkspace.findMany({
        where: {
          spaceId: actor.spaceId,
          OR: [
            { ownerUserId: actor.userId },
            { algorithmApproverUserId: actor.userId },
            { tradeApproverUserId: actor.userId },
          ],
        },
        include,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map(dto);
    },
    create(actor: Actor, input: RpcInput<"trading/createWorkspace">) {
      return withTransactionRetry(() =>
        prisma.$transaction((tx) => configure(tx, actor, input, clock())),
      );
    },
    /** Called in an explicit system scope: creation verifies source membership inside the transaction. */
    async createBusinessScope(actor: Actor, input: RpcInput<"trading/createBusinessScope">) {
      tradingAssert(
        input.algorithmApproverUserId === actor.userId &&
          input.tradeApproverUserId === actor.userId,
        "FORBIDDEN",
        "A new business scope initially contains only its creator",
      );
      let result: TradingWorkspace | undefined;
      await createSpaceForMember(prisma, {
        currentSpaceId: actor.spaceId,
        userId: actor.userId,
        name: input.name,
        id: input.id ?? randomUUID(),
        initialize: async (tx, space) => {
          result = await configure(
            tx,
            { ...actor, spaceId: space.id },
            { ...input, id: space.id },
            clock(),
          );
        },
      });
      return result!;
    },
    connect(actor: Actor, input: RpcInput<"trading/connectWorkspaceBot">) {
      return withTransactionRetry(() =>
        prisma.$transaction((tx) =>
          connectTradingWorkspaceBot(tx, actor, input.workspaceId, input.botId, clock()),
        ),
      );
    },
    async interfaces(actor: Actor, workspaceId: string) {
      await access(prisma, actor, workspaceId, true);
      const rows = await prisma.tradingWorkspaceInterface.findMany({
        where: { workspaceId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return rows.map(interfaceDto);
    },
    async canConfigure(actor: Actor, workspaceId: string) {
      await access(prisma, actor, workspaceId, true);
    },
    saveInterface(actor: Actor, input: RpcInput<"trading/saveInterface">, stored?: SecretRecord) {
      return change(actor, input.workspaceId, async (tx) => {
        const existing = await tx.tradingWorkspaceInterface.findUnique({ where: { id: input.id } });
        tradingAssert(
          !existing || existing.workspaceId === input.workspaceId,
          "NOT_FOUND",
          "Interface not found",
        );
        tradingAssert(
          (existing?.revision ?? 0) === input.expectedRevision,
          "IDEMPOTENCY_CONFLICT",
          "Interface changed; reload before editing",
        );
        if (input.config.transport === "mcp") {
          const server = await tx.mcpServer.findFirst({
            where: {
              id: input.config.serverId,
              userId: actor.userId,
              OR: [
                { spaceId: actor.spaceId },
                { allSpaces: true },
                { availableIn: { some: { spaceId: actor.spaceId } } },
              ],
            },
          });
          tradingAssert(server, "NOT_FOUND", "MCP connection not found");
        }
        const needsSecret = input.config.transport === "http" && input.config.auth !== "none";
        if (stored && needsSecret)
          await tx.secret.create({
            data: {
              id: stored.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              kind: "connector",
              ciphertext: stored.ciphertext,
            },
          });
        const secretId = needsSecret ? (stored?.id ?? existing?.secretId ?? null) : null;
        tradingAssert(!needsSecret || secretId, "INVALID_INPUT", "Configure an API credential");
        const fields = {
          name: input.name,
          purpose: input.purpose,
          config: input.config as Prisma.InputJsonValue,
          secretId,
          revision: input.expectedRevision + 1,
          updatedAt: clock(),
        };
        const row = await tx.tradingWorkspaceInterface.upsert({
          where: { id: input.id },
          create: { id: input.id, workspaceId: input.workspaceId, ...fields },
          update: fields,
        });
        if (existing?.secretId && existing.secretId !== secretId)
          await tx.secret.deleteMany({
            where: { id: existing.secretId, userId: actor.userId, spaceId: actor.spaceId },
          });
        return interfaceDto(row);
      });
    },
    removeInterface(actor: Actor, input: RpcInput<"trading/removeInterface">) {
      return change(actor, input.workspaceId, async (tx) => {
        const row = await tx.tradingWorkspaceInterface.findFirst({
          where: { id: input.id, workspaceId: input.workspaceId },
        });
        if (!row) return { removed: false };
        tradingAssert(
          row.revision === input.expectedRevision,
          "IDEMPOTENCY_CONFLICT",
          "Interface changed; reload before removing",
        );
        await tx.tradingWorkspaceInterface.delete({ where: { id: row.id } });
        if (row.secretId)
          await tx.secret.deleteMany({
            where: { id: row.secretId, userId: actor.userId, spaceId: actor.spaceId },
          });
        return { removed: true };
      });
    },
  };
}

import { randomUUID } from "node:crypto";
import type { Actor, RpcInput, WorkspaceMaterial } from "@rakazo/contracts";
import { WorkspaceMaterialSchema, WorkspaceReadGrantSchema } from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";
import { requireIsolatedBot, requireWorkspaceKind } from "./workspace-isolation.js";

type Tx = Prisma.TransactionClient;
type Grant = Prisma.WorkspaceReadGrantGetPayload<object>;
const dto = (row: Grant) =>
  WorkspaceReadGrantSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
async function sourceOwner(db: Tx | PrismaClient, actor: Actor) {
  await requireWorkspaceKind(db, actor.spaceId, "trading");
  tradingAssert(
    await db.spaceMember.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, role: "owner" },
    }),
    "FORBIDDEN",
    "Only the source workspace owner can grant material access",
  );
}
async function material(
  db: Tx | PrismaClient,
  grant: Pick<Grant, "kind" | "resourceId" | "sourceSpaceId" | "createdByUserId">,
): Promise<WorkspaceMaterial> {
  const where = {
    id: grant.resourceId,
    spaceId: grant.sourceSpaceId,
    userId: grant.createdByUserId,
  };
  let value: WorkspaceMaterial | undefined;
  if (grant.kind === "memory") {
    const row = await db.memoryDocument.findFirst({ where });
    if (row)
      value = {
        kind: "memory",
        resourceId: row.id,
        title: row.path,
        revision: String(row.revision),
        content: { scope: row.scope, botId: row.botId, text: row.content },
      };
  } else if (grant.kind === "skill") {
    const row = await db.agentSkill.findFirst({ where });
    if (row)
      value = {
        kind: "skill",
        resourceId: row.id,
        title: row.name,
        revision: row.updatedAt.toISOString(),
        content: {
          description: row.description,
          text: row.content,
          files: WorkspaceMaterialSchema.shape.content.parse(row.files),
        },
      };
  } else if (grant.kind === "analysis") {
    const row = await db.tradingAnalysis.findFirst({ where });
    if (row)
      value = {
        kind: "analysis",
        resourceId: row.id,
        title: row.id,
        revision: row.createdAt.toISOString(),
        content: JSON.parse(JSON.stringify(row)),
      };
  } else if (grant.kind === "weather") {
    const row = await db.tradingWeatherForecast.findFirst({
      where: {
        id: grant.resourceId,
        workspace: { spaceId: grant.sourceSpaceId, ownerUserId: grant.createdByUserId },
      },
    });
    if (row)
      value = {
        kind: "weather",
        resourceId: row.id,
        title: row.batchId,
        revision: row.receivedAt.toISOString(),
        content: WorkspaceMaterialSchema.shape.content.parse(row.forecast),
      };
  }
  tradingAssert(value, "NOT_FOUND", "Selected material is unavailable");
  tradingAssert(
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024,
    "INVALID_INPUT",
    "Selected material exceeds the read budget",
  );
  return WorkspaceMaterialSchema.parse(value);
}
async function audit(
  tx: Tx,
  grant: Grant,
  actorUserId: string,
  action: string,
  actorBotId?: string,
) {
  await tx.workspaceAccessAudit.create({
    data: {
      id: randomUUID(),
      grantId: grant.id,
      sourceSpaceId: grant.sourceSpaceId,
      actorUserId,
      actorBotId,
      action,
    },
  });
}
export function createWorkspaceAccessService(prisma: PrismaClient) {
  const inSystem = <T>(reason: string, action: () => Promise<T>) => runAsSystem(reason, action);
  return {
    async catalog(actor: Actor) {
      await sourceOwner(prisma, actor);
      const where = { spaceId: actor.spaceId, userId: actor.userId };
      const [memories, skills, analyses, weather] = await Promise.all([
        prisma.memoryDocument.findMany({
          where,
          select: { id: true, path: true, revision: true },
          orderBy: { updatedAt: "desc" },
          take: 50,
        }),
        prisma.agentSkill.findMany({
          where,
          select: { id: true, name: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 50,
        }),
        prisma.tradingAnalysis.findMany({
          where,
          select: { id: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        prisma.tradingWeatherForecast.findMany({
          where: { workspace: { spaceId: actor.spaceId, ownerUserId: actor.userId } },
          select: { id: true, batchId: true, receivedAt: true },
          orderBy: { issuedAt: "desc" },
          take: 50,
        }),
      ]);
      return [
        ...memories.map((r) => ({
          kind: "memory" as const,
          resourceId: r.id,
          title: r.path,
          revision: String(r.revision),
        })),
        ...skills.map((r) => ({
          kind: "skill" as const,
          resourceId: r.id,
          title: r.name,
          revision: r.updatedAt.toISOString(),
        })),
        ...analyses.map((r) => ({
          kind: "analysis" as const,
          resourceId: r.id,
          title: r.id,
          revision: r.createdAt.toISOString(),
        })),
        ...weather.map((r) => ({
          kind: "weather" as const,
          resourceId: r.id,
          title: r.batchId,
          revision: r.receivedAt.toISOString(),
        })),
      ];
    },
    async grants(actor: Actor) {
      await sourceOwner(prisma, actor);
      return (
        await prisma.workspaceReadGrant.findMany({
          where: { sourceSpaceId: actor.spaceId, createdByUserId: actor.userId },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      ).map(dto);
    },
    async grant(actor: Actor, input: RpcInput<"workspaceAccess/grant">) {
      await sourceOwner(prisma, actor);
      return inSystem("grant selected trading material to an owned general Bot", () =>
        withTransactionRetry(() =>
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM spaces WHERE id=${actor.spaceId} FOR UPDATE`;
            await sourceOwner(tx, actor);
            const target = await tx.bot.findFirst({
              where: {
                id: input.recipientBotId,
                userId: actor.userId,
                tradingRole: null,
                archivedAt: null,
                space: {
                  kind: "general",
                  isolationPending: false,
                  memberships: { some: { userId: actor.userId } },
                },
              },
            });
            tradingAssert(
              target,
              "NOT_FOUND",
              "Recipient must be an owned general Bot in a general workspace",
            );
            const fields = {
              sourceSpaceId: actor.spaceId,
              recipientSpaceId: target.spaceId,
              recipientBotId: target.id,
              createdByUserId: actor.userId,
              kind: input.kind,
              resourceId: input.resourceId,
            };
            await material(tx, fields);
            const prior = await tx.workspaceReadGrant.findUnique({ where: { id: input.id } });
            if (prior) {
              tradingAssert(
                Object.entries(fields).every(([k, v]) => prior[k as keyof Grant] === v),
                "IDEMPOTENCY_CONFLICT",
                "Grant request changed",
              );
              return dto(prior);
            }
            const active = await tx.workspaceReadGrant.findFirst({
              where: { ...fields, revokedAt: null },
            });
            if (active) return dto(active);
            const row = await tx.workspaceReadGrant.create({ data: { id: input.id, ...fields } });
            await audit(tx, row, actor.userId, "granted");
            return dto(row);
          }),
        ),
      );
    },
    async revoke(actor: Actor, id: string) {
      await sourceOwner(prisma, actor);
      return inSystem("revoke owned trading material access", () =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM workspace_read_grants WHERE id=${id} FOR UPDATE`;
          await sourceOwner(tx, actor);
          const row = await tx.workspaceReadGrant.findFirst({
            where: { id, sourceSpaceId: actor.spaceId, createdByUserId: actor.userId },
          });
          tradingAssert(row, "NOT_FOUND", "Read grant not found");
          if (row.revokedAt) return dto(row);
          const revoked = await tx.workspaceReadGrant.update({
            where: { id },
            data: { revokedAt: new Date() },
          });
          await audit(tx, row, actor.userId, "revoked");
          return dto(revoked);
        }),
      );
    },
    async received(identity: { spaceId: string; userId: string; botId: string }) {
      const bot = await requireIsolatedBot(prisma, identity);
      tradingAssert(!bot.tradingRole, "FORBIDDEN", "Material access is for general Bots");
      return inSystem("list explicit material grants with current source membership", async () => {
        const rows = await prisma.workspaceReadGrant.findMany({
          where: {
            recipientBotId: bot.id,
            recipientSpaceId: identity.spaceId,
            createdByUserId: identity.userId,
            revokedAt: null,
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        const sources = await prisma.spaceMember.findMany({
          where: {
            userId: identity.userId,
            role: "owner",
            spaceId: { in: rows.map((r) => r.sourceSpaceId) },
            space: { kind: "trading", isolationPending: false, deletingAt: null },
          },
          select: { spaceId: true },
        });
        const allowed = new Set(sources.map((s) => s.spaceId));
        return rows.filter((r) => allowed.has(r.sourceSpaceId)).map(dto);
      });
    },
    async read(identity: { spaceId: string; userId: string; botId: string }, grantId: string) {
      const bot = await requireIsolatedBot(prisma, identity);
      tradingAssert(!bot.tradingRole, "FORBIDDEN", "Material access is for general Bots");
      const result = await inSystem("read exactly one authorized trading material record", () =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM workspace_read_grants WHERE id=${grantId} FOR UPDATE`;
          const grant = await tx.workspaceReadGrant.findUnique({ where: { id: grantId } });
          if (!grant) return null;
          const allowed =
            grant.recipientBotId === identity.botId &&
            grant.recipientSpaceId === identity.spaceId &&
            grant.createdByUserId === identity.userId &&
            !grant.revokedAt &&
            (await tx.spaceMember.findFirst({
              where: {
                spaceId: grant.sourceSpaceId,
                userId: identity.userId,
                role: "owner",
                space: { kind: "trading", isolationPending: false, deletingAt: null },
              },
            }));
          if (!allowed) {
            await audit(tx, grant, identity.userId, "read_denied", identity.botId);
            return null;
          }
          // No connection configuration or source-space execution context is fetched.
          const selected = await material(tx, grant);
          await audit(tx, grant, identity.userId, "read", identity.botId);
          return { grant: dto(grant), material: selected };
        }),
      );
      tradingAssert(result, "FORBIDDEN", "Material access is unavailable or revoked");
      return result;
    },
    async audit(actor: Actor) {
      await sourceOwner(prisma, actor);
      const rows = await prisma.workspaceAccessAudit.findMany({
        where: { sourceSpaceId: actor.spaceId },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return rows.map((row) => ({
        ...row,
        action: row.action as "granted" | "revoked" | "read" | "read_denied",
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}

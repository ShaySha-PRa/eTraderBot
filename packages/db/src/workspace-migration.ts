import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceMigrationChoice } from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { computerHomeKey, computerScopeKey } from "./computers.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { runAsSystem } from "./row-security.js";

export type { WorkspaceMigrationChoice } from "@rakazo/contracts";

type Db = PrismaClient | Prisma.TransactionClient;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function inventory(db: Db, choice: WorkspaceMigrationChoice) {
  const source = await db.space.findUnique({ where: { id: choice.sourceSpaceId } });
  const owner = await db.spaceMember.findFirst({
    where: { spaceId: choice.sourceSpaceId, userId: choice.userId, role: "owner" },
  });
  tradingAssert(
    source && owner && source.kind === "trading",
    "FORBIDDEN",
    "Source must be an owned trading workspace",
  );
  const bots = await db.bot.findMany({
    where: {
      id: { in: choice.botIds },
      spaceId: source.id,
      userId: choice.userId,
      tradingRole: null,
    },
    orderBy: { id: "asc" },
    include: { computer: true },
  });
  tradingAssert(
    choice.botIds.length > 0 &&
      new Set(choice.botIds).size === choice.botIds.length &&
      bots.length === choice.botIds.length,
    "INVALID_INPUT",
    "Select explicit ordinary Bot IDs from the source workspace",
  );
  const ids = bots.map((b) => b.id);
  const botWhere = { botId: { in: ids } };
  const threads = await db.thread.findMany({ where: botWhere, orderBy: { id: "asc" } });
  const threadIds = threads.map((t) => t.id);
  const [
    messages,
    events,
    memories,
    runs,
    tasks,
    routines,
    profiles,
    groups,
    bindings,
    skills,
    scratchpad,
    artifacts,
    homes,
    children,
    effects,
    imports,
  ] = await Promise.all([
    db.message.findMany({ where: { threadId: { in: threadIds } }, orderBy: { id: "asc" } }),
    db.event.findMany({ where: { threadId: { in: threadIds } }, orderBy: { id: "asc" } }),
    db.memoryDocument.findMany({
      where: botWhere,
      orderBy: { id: "asc" },
      include: { revisions: { orderBy: { id: "asc" } } },
    }),
    db.run.findMany({ where: botWhere, orderBy: { id: "asc" } }),
    db.task.findMany({ where: botWhere, orderBy: { id: "asc" } }),
    db.routine.findMany({ where: botWhere, orderBy: { id: "asc" } }),
    db.browserProfile.findMany({ where: botWhere, orderBy: { id: "asc" } }),
    db.chatGroupMember.count({ where: botWhere }),
    db.tradingBotBinding.count({ where: botWhere }),
    db.taughtSkill.count({ where: botWhere }),
    db.scratchpadItem.count({ where: botWhere }),
    db.artifact.count({ where: { spaceId: source.id } }),
    db.agentHome.findMany({ where: botWhere }),
    db.bot.count({ where: { parentBotId: { in: ids }, id: { notIn: ids } } }),
    db.externalEffect.findMany({ where: { run: { botId: { in: ids } } }, orderBy: { id: "asc" } }),
    db.agentImport.count({ where: botWhere }),
  ]);
  const blockers: string[] = [];
  if (await db.space.findUnique({ where: { id: choice.targetSpaceId } }))
    blockers.push("Target workspace already exists");
  if (
    groups ||
    bindings ||
    children ||
    bots.some((b) => b.parentBotId && !ids.includes(b.parentBotId))
  )
    blockers.push(
      "Shared groups, child relationships or legacy trading bindings need an explicit ownership decision",
    );
  if (skills || scratchpad || artifacts || imports || homes.some((h) => h.revision !== "empty"))
    blockers.push(
      "Files, imports, taught skills or scratchpad ownership needs a separate reviewed plan",
    );
  if (profiles.some((p) => p.secretId) || bots.some((b) => b.webhookSecretId))
    blockers.push("Browser credentials or webhook identity needs a separate reviewed plan");
  if (bots.some((b) => b.computer?.scope === "dedicated" || b.computerSwitching))
    blockers.push("Dedicated or switching computers require a separate file ownership plan");
  if (
    runs.some((r) => !["completed", "failed", "cancelled"].includes(r.status)) ||
    routines.some((r) => r.webhookEnabled || r.githubEnabled || r.messageProvider)
  )
    blockers.push("Stop active runs and external routine deliveries before migration");
  if (
    threads.some(
      (t) =>
        t.spaceId !== source.id ||
        t.userId !== choice.userId ||
        t.groupId ||
        t.externalConversationId,
    ) ||
    memories.some(
      (m) => m.spaceId !== source.id || m.userId !== choice.userId || m.scope !== "bot",
    ) ||
    [...runs, ...tasks].some(
      (r) =>
        r.spaceId !== source.id || r.userId !== choice.userId || !threadIds.includes(r.threadId),
    )
  )
    blockers.push("Inconsistent or externally shared history requires review");
  if (
    [...routines, ...profiles, ...homes].some(
      (row) => row.spaceId !== source.id || row.userId !== choice.userId,
    ) ||
    effects.some((row) => row.spaceId !== source.id)
  )
    blockers.push("Auxiliary history ownership requires review");
  const dedicatedHistory = await db.computer.count({
    where: { scopeKey: { in: ids.map((id) => `bot:${id}`) } },
  });
  if (dedicatedHistory)
    blockers.push("Historical dedicated computer files require a separate ownership plan");
  const crossThreadMessages = await db.message.count({
    where: {
      OR: [
        { threadId: { in: threadIds }, replyTo: { threadId: { notIn: threadIds } } },
        { threadId: { notIn: threadIds }, replyTo: { threadId: { in: threadIds } } },
        { threadId: { in: threadIds }, botId: { not: null, notIn: ids } },
      ],
    },
  });
  if (crossThreadMessages) blockers.push("Cross-thread message references require review");
  const evidence = {
    bots,
    threads,
    messages,
    events,
    memories,
    runs,
    tasks,
    routines,
    profiles,
    effects,
  };
  return {
    source,
    owner,
    ...evidence,
    blockers,
    fingerprint: digest({ choice, evidence, blockers }),
    counts: {
      bots: bots.length,
      threads: threads.length,
      messages: messages.length,
      events: events.length,
      memories: memories.length,
      runs: runs.length,
      routines: routines.length,
    },
  };
}
export async function preflightWorkspaceMigration(
  prisma: PrismaClient,
  choice: WorkspaceMigrationChoice,
) {
  return runAsSystem("preflight explicit legacy workspace ownership", async () => {
    const result = await inventory(prisma, choice);
    return {
      choice,
      fingerprint: result.fingerprint,
      counts: result.counts,
      blockers: result.blockers,
      retained: [
        "shared memory",
        "shared computers and files",
        "skills",
        "interfaces and credentials",
        "all trading evidence",
      ],
    };
  });
}
export async function migrateWorkspaceOwnership(
  prisma: PrismaClient,
  choice: WorkspaceMigrationChoice,
  expectedFingerprint: string,
) {
  const ring = contentEncryptionOf(prisma)?.ring;
  return runAsSystem("apply reviewed offline workspace ownership migration", async () => {
    try {
      // Provision the key outside the transaction: the key store uses its own connection.
      if (ring) await ring.current(choice.targetSpaceId);
      return await prisma.$transaction(
        async (tx) => {
          // Offline maintenance only: keep histories stable while decrypting and re-keying.
          await tx.$executeRawUnsafe(
            "LOCK TABLE spaces, bots, threads, messages, events, memory_documents, memory_revisions, tasks, runs, routines IN SHARE ROW EXCLUSIVE MODE",
          );
          const data = await inventory(tx, choice);
          tradingAssert(
            data.fingerprint === expectedFingerprint,
            "CONFLICT",
            "Preflight changed; review a fresh preflight",
          );
          tradingAssert(data.blockers.length === 0, "INVALID_INPUT", data.blockers.join("; "));
          tradingAssert(
            choice.targetName.trim().length > 0 && choice.targetName.length <= 60,
            "INVALID_INPUT",
            "Invalid target workspace name",
          );
          await tx.space.create({
            data: {
              id: choice.targetSpaceId,
              name: choice.targetName.trim(),
              kind: "general",
              organizationId: data.source.organizationId,
              createdByUserId: choice.userId,
            },
          });
          await tx.spaceMember.create({
            data: {
              id: randomUUID(),
              spaceId: choice.targetSpaceId,
              organizationId: data.source.organizationId,
              userId: choice.userId,
              role: "owner",
              createdAt: new Date(),
            },
          });
          const computerInput = {
            mode: "team" as const,
            spaceId: choice.targetSpaceId,
            userId: choice.userId,
          };
          const computer = await tx.computer.create({
            data: {
              spaceId: choice.targetSpaceId,
              userId: choice.userId,
              scope: "team",
              scopeKey: computerScopeKey(computerInput),
              homeKey: computerHomeKey(computerInput),
              kind: data.bots[0]?.computer?.kind ?? "docker",
            },
          });
          for (const bot of data.bots)
            await tx.bot.update({
              where: { id: bot.id },
              data: {
                spaceId: choice.targetSpaceId,
                computerId: computer.id,
                sectionId: null,
                crossSpaceCommunication: false,
              },
            });
          for (const thread of data.threads) {
            ring?.remember("threads", thread.id, {
              spaceId: choice.targetSpaceId,
              owner: thread.userId,
            });
            await tx.thread.updateMany({
              where: { id: thread.id },
              data: {
                spaceId: choice.targetSpaceId,
                historyCompactionSummary: thread.historyCompactionSummary,
              },
            });
          }
          for (const message of data.messages) {
            ring?.remember("messages", message.id, {
              spaceId: choice.targetSpaceId,
              owner: message.threadId,
            });
            await tx.message.updateMany({
              where: { id: message.id },
              data: { blocks: message.blocks as Prisma.InputJsonValue },
            });
          }
          for (const event of data.events) {
            ring?.remember("events", event.id, {
              spaceId: choice.targetSpaceId,
              owner: event.threadId,
            });
            await tx.event.updateMany({
              where: { id: event.id },
              data: {
                spaceId: choice.targetSpaceId,
                payload: event.payload as Prisma.InputJsonValue,
              },
            });
          }
          for (const memory of data.memories) {
            ring?.remember("memory_documents", memory.id, {
              spaceId: choice.targetSpaceId,
              owner: memory.userId,
            });
            await tx.memoryDocument.updateMany({
              where: { id: memory.id },
              data: {
                spaceId: choice.targetSpaceId,
                content: memory.content,
                updatedAt: memory.updatedAt,
              },
            });
            for (const revision of memory.revisions) {
              ring?.remember("memory_revisions", revision.id, {
                spaceId: choice.targetSpaceId,
                owner: memory.id,
              });
              await tx.memoryRevision.updateMany({
                where: { id: revision.id },
                data: { content: revision.content },
              });
            }
          }
          for (const task of data.tasks)
            await tx.task.updateMany({
              where: { id: task.id },
              data: { spaceId: choice.targetSpaceId, updatedAt: task.updatedAt },
            });
          for (const run of data.runs)
            await tx.run.updateMany({
              where: { id: run.id },
              data: { spaceId: choice.targetSpaceId, updatedAt: run.updatedAt },
            });
          for (const effect of data.effects)
            await tx.externalEffect.updateMany({
              where: { id: effect.id },
              data: { spaceId: choice.targetSpaceId },
            });
          for (const routine of data.routines)
            await tx.routine.updateMany({
              where: { id: routine.id },
              data: { spaceId: choice.targetSpaceId, active: false, nextRunAt: null },
            });
          for (const profile of data.profiles)
            await tx.browserProfile.updateMany({
              where: { id: profile.id },
              data: { spaceId: choice.targetSpaceId },
            });
          await tx.agentHome.updateMany({
            where: { botId: { in: choice.botIds }, revision: "empty" },
            data: { spaceId: choice.targetSpaceId },
          });
          const remaining = await tx.bot.count({
            where: { spaceId: choice.sourceSpaceId, tradingRole: null },
          });
          await tx.space.update({
            where: { id: choice.sourceSpaceId },
            data: { isolationPending: remaining > 0 },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: data.source.organizationId,
              spaceId: choice.sourceSpaceId,
              actorType: "user",
              actorId: choice.userId,
              action: "workspace.ownership_migrated",
              targetType: "space",
              targetId: choice.targetSpaceId,
              outcome: "success",
              metadata: {
                ...choice,
                fingerprint: data.fingerprint,
                counts: data.counts,
                priorComputers: data.bots.map((b) => ({
                  botId: b.id,
                  computerId: b.computerId,
                  sectionId: b.sectionId,
                })),
                routinesPaused: data.routines.map((r) => r.id),
              },
            },
          });
          return {
            targetSpaceId: choice.targetSpaceId,
            counts: data.counts,
            sourcePending: remaining > 0,
          };
        },
        { timeout: 120_000 },
      );
    } finally {
      ring?.clear();
    }
  });
}

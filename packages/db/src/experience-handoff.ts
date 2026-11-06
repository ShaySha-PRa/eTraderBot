import { createHash, randomUUID } from "node:crypto";
import type { Actor, HandoffItem, HandoffPlan, HandoffReceipt, RpcInput } from "@rakazo/contracts";
import {
  CreateHandoffInputSchema,
  HandoffPackageSchema,
  HandoffReceiptSchema,
  HandoffSkillSchema,
  HandoffSnapshotSchema,
} from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import { availableInSpace } from "./availability.js";
import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";
import { requireIsolatedBot, requireWorkspaceKind } from "./workspace-isolation.js";

type Tx = Prisma.TransactionClient;
type PackageRow = Prisma.ExperiencePackageGetPayload<object>;
type SkillRow = Prisma.ExperienceSkillGetPayload<object>;
export class ExperienceHandoffError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
function assert(value: unknown, reason: string, message: string): asserts value {
  if (!value) throw new ExperienceHandoffError(reason, message);
}
// Sorted object keys make retries independent of client JSON key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const dto = (row: PackageRow) =>
  HandoffPackageSchema.parse({
    ...row,
    sourceSpaceId: row.spaceId,
    snapshot: row.snapshot,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
export const experienceSkillDto = (row: SkillRow) =>
  HandoffSkillSchema.parse({
    ...row,
    ...jsonObject(row.payload),
    enabledAt: row.enabledAt?.toISOString() ?? null,
    blockedReason: null,
  });
function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
async function owner(tx: Tx, actor: Pick<Actor, "userId" | "spaceId">) {
  const space = await tx.space.findFirst({
    where: {
      id: actor.spaceId,
      deletingAt: null,
      memberships: { some: { userId: actor.userId, role: "owner" } },
    },
  });
  assert(space, "FORBIDDEN", "Workspace owner access is required");
  await requireWorkspaceKind(tx, space.id, space.kind === "trading" ? "trading" : "general");
  return space;
}
async function nativeMemory(tx: Tx, spaceId: string) {
  assert(
    !(await tx.spaceMemoryConfig.findUnique({ where: { spaceId } })),
    "MEMORY_PROVIDER_UNSUPPORTED",
    "Experience memory copies require the native memory store",
  );
}
async function source(tx: Tx, actor: Actor, packageId: string) {
  const row = await tx.experiencePackage.findFirst({
    where: { id: packageId, userId: actor.userId },
  });
  assert(row, "NOT_FOUND", "Experience package is unavailable");
  await owner(tx, { ...actor, spaceId: row.spaceId });
  return row;
}
async function event(
  tx: Tx,
  actor: Actor,
  packageId: string,
  kind: string,
  payload: unknown,
  importId?: string,
) {
  await tx.experienceHandoffEvent.create({
    data: {
      id: randomUUID(),
      spaceId: actor.spaceId,
      userId: actor.userId,
      packageId,
      kind,
      payload: json(payload),
      importId,
    },
  });
}
function skillText(content: string, targetName?: string) {
  const parsed = parseSkillMd(content);
  assert(!("error" in parsed), "INVALID_INPUT", "Invalid SKILL.md snapshot");
  const name = targetName ?? parsed.name;
  // Frontmatter is an allowlist. Tool/environment/permission directives are not inherited.
  return {
    name,
    description: parsed.description,
    content: buildSkillMd({ name, description: parsed.description, body: parsed.body }),
  };
}
function safeFiles(value: unknown): Record<string, string> {
  const entries = Object.entries(jsonObject(value));
  assert(entries.length <= 50, "INVALID_INPUT", "Too many Skill reference files");
  for (const [path, text] of entries) {
    assert(
      /^[\w./ -]+$/.test(path) &&
        !path.startsWith("/") &&
        !path.split("/").some((p) => p === ".." || p.startsWith(".")) &&
        /\.(md|txt|json|csv|yaml|yml)$/i.test(path) &&
        typeof text === "string" &&
        text.length <= 100_000,
      "INVALID_INPUT",
      "Only bounded relative text reference files can be handed off",
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
function validatePlan(items: HandoffItem[], plan: HandoffPlan): HandoffPlan {
  assert(
    plan.length === items.length && new Set(plan.map((p) => p.itemKey)).size === items.length,
    "INVALID_INPUT",
    "Choose copy or skip for every item exactly once",
  );
  return items.map((item) => {
    const entry = plan.find((p) => p.itemKey === item.key);
    assert(entry, "INVALID_INPUT", "Unknown or missing handoff item");
    if (entry.action === "copy") {
      const valid =
        item.kind === "skill"
          ? /^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.targetName)
          : /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(entry.targetName) &&
            !entry.targetName.split("/").some((p) => p.startsWith("."));
      assert(valid, "INVALID_INPUT", "Use a relative Markdown path or a lowercase Skill slug");
    }
    return entry;
  });
}
async function skillCollision(
  tx: Tx,
  actor: Actor,
  botId: string,
  name: string,
  exceptId?: string,
) {
  const native = await tx.agentSkill.findFirst({
    where: {
      ...availableInSpace(actor),
      name: { equals: name, mode: "insensitive" },
    },
    select: { id: true, updatedAt: true },
  });
  const copy = await tx.experienceSkill.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, revision: true },
  });
  return {
    native: native ? { id: native.id, revision: native.updatedAt.toISOString() } : null,
    copy,
  };
}

export function createExperienceHandoffService(
  prisma: PrismaClient,
  reservedSkillNames: readonly string[] = [],
) {
  const reservedNames = new Set(reservedSkillNames.map((name) => name.toLowerCase()));
  // Cross-space work is deliberately available only through authenticated user RPCs.
  // No Bot tool receives this service. Every operation revalidates membership and ownership.
  async function transaction<T>(actor: Actor, action: (tx: Tx) => Promise<T>): Promise<T> {
    return runAsSystem(
      "user-confirmed fixed-version experience handoff across owned workspaces",
      async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await withTransactionRetry(() =>
              prisma.$transaction(
                async (tx) => {
                  await owner(tx, actor);
                  return action(tx);
                },
                { isolationLevel: "Serializable", timeout: 20_000 },
              ),
            );
          } catch (error) {
            // Concurrent idempotency keys / names can race at a unique index before SSI detects it.
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "P2002" &&
              attempt < 2
            )
              continue;
            throw error;
          }
        }
      },
    );
  }
  async function preview(tx: Tx, actor: Actor, input: RpcInput<"experienceHandoff/preview">) {
    const row = await source(tx, actor, input.packageId);
    const target = await requireIsolatedBot(tx, { ...actor, botId: input.targetBotId });
    const pkg = dto(row);
    let plan = validatePlan(
      pkg.snapshot.items,
      input.plan ??
        pkg.snapshot.items.map((item, i) => ({
          itemKey: item.key,
          action: "copy" as const,
          targetName:
            item.kind === "skill"
              ? `handoff-${row.id.slice(0, 8)}-${i + 1}`
              : `handoff/${row.id}/${i + 1}.md`,
        })),
    );
    const existing = await tx.experienceImport.findUnique({
      where: { packageId_targetBotId: { packageId: row.id, targetBotId: target.id } },
    });
    if (existing) {
      assert(
        existing.userId === actor.userId && existing.spaceId === actor.spaceId,
        "FORBIDDEN",
        "Import is unavailable",
      );
      if (!input.plan) {
        plan = HandoffReceiptSchema.parse(existing.receipt).items.map((item) => ({
          itemKey: item.itemKey,
          action: item.status === "skipped" ? "skip" : "copy",
          targetName: item.targetName,
        }));
      }
      assert(
        existing.planHash === hash(plan),
        "CONFLICT",
        "This version was already imported with a different plan",
      );
      return {
        package: pkg,
        plan,
        previewHash: hash([row.contentHash, plan, existing.id]),
        conflicts: [],
        alreadyImported: HandoffReceiptSchema.parse(existing.receipt),
      };
    }
    assert(!row.revokedAt, "PACKAGE_REVOKED", "This package has been revoked");
    await requireIsolatedBot(tx, {
      userId: actor.userId,
      spaceId: row.spaceId,
      botId: row.sourceBotId,
    });
    if (
      plan.some(
        (p) =>
          p.action === "copy" &&
          pkg.snapshot.items.find((i) => i.key === p.itemKey)?.kind !== "skill",
      )
    )
      await nativeMemory(tx, actor.spaceId);
    const conflicts: { itemKey: string; reason: string }[] = [];
    const state: unknown[] = [];
    const names = new Set<string>();
    for (const entry of plan) {
      if (entry.action === "skip") continue;
      const item = pkg.snapshot.items.find((i) => i.key === entry.itemKey)!;
      const namespace = `${item.kind === "skill" ? "skill" : "memory"}:${entry.targetName.toLowerCase()}`;
      if (names.has(namespace)) conflicts.push({ itemKey: item.key, reason: "DUPLICATE_TARGET" });
      names.add(namespace);
      if (item.kind === "skill") {
        const found = await skillCollision(tx, actor, target.id, entry.targetName);
        const builtin = reservedNames.has(entry.targetName.toLowerCase());
        state.push({ ...found, builtin });
        if (builtin) conflicts.push({ itemKey: item.key, reason: "BUILTIN_SKILL_NAME" });
        if (found.native || found.copy)
          conflicts.push({ itemKey: item.key, reason: "TARGET_EXISTS" });
      } else {
        const found = await tx.memoryDocument.findFirst({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            scope: "bot",
            botId: target.id,
            path: entry.targetName,
          },
          select: { id: true, revision: true },
        });
        state.push(found);
        if (found) conflicts.push({ itemKey: item.key, reason: "TARGET_EXISTS" });
      }
    }
    return {
      package: pkg,
      plan,
      previewHash: hash([row.contentHash, target.id, actor.spaceId, plan, state]),
      conflicts,
      alreadyImported: null,
    };
  }
  return {
    catalog(actor: Actor, input: RpcInput<"experienceHandoff/catalog">) {
      return transaction(actor, async (tx) => {
        await requireIsolatedBot(tx, { ...actor, botId: input.sourceBotId });
        const scope = { spaceId: actor.spaceId, userId: actor.userId };
        const external = await tx.spaceMemoryConfig.findUnique({
          where: { spaceId: actor.spaceId },
        });
        const memories = external
          ? []
          : await tx.memoryDocument.findMany({
              where: {
                ...scope,
                OR: [
                  { scope: "bot", botId: input.sourceBotId },
                  { scope: "user", botId: null },
                ],
              },
              orderBy: { path: "asc" },
            });
        const skills = await tx.agentSkill.findMany({ where: scope, orderBy: { name: "asc" } });
        const copies = await tx.experienceSkill.findMany({
          where: { ...scope, botId: input.sourceBotId },
          orderBy: { name: "asc" },
        });
        return [
          ...copies.map((s) => ({
            id: `handoff:${s.id}`,
            kind: "skill" as const,
            sourceType: "imported_skill" as const,
            title: s.name,
            revision: String(s.revision),
          })),
          ...memories.map((m) => ({
            id: m.id,
            kind: "memory" as const,
            sourceType: m.scope === "bot" ? ("bot_memory" as const) : ("shared_memory" as const),
            title: m.path,
            revision: String(m.revision),
          })),
          ...skills.map((s) => ({
            id: s.id,
            kind: "skill" as const,
            sourceType: "workspace_skill" as const,
            title: s.name,
            revision: s.updatedAt.toISOString(),
          })),
        ];
      });
    },
    create(actor: Actor, raw: RpcInput<"experienceHandoff/create">) {
      const input = CreateHandoffInputSchema.parse(raw);
      return transaction(actor, async (tx) => {
        const bot = await requireIsolatedBot(tx, { ...actor, botId: input.sourceBotId });
        const existing = await tx.experiencePackage.findUnique({
          where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } },
        });
        const requestHash = hash({ spaceId: actor.spaceId, input });
        if (existing) {
          assert(
            existing.requestHash === requestHash,
            "CONFLICT",
            "Creation key was used for a different selection",
          );
          return dto(existing);
        }
        const space = await owner(tx, actor);
        const items: HandoffItem[] = input.summaries.map((s, i) => ({
          ...s,
          key: `summary:${i + 1}`,
          kind: "summary",
          description: null,
          files: null,
          sourceId: null,
          sourceRevision: "user-selected",
          contentHash: hash(s),
        }));
        if (input.memories.length) await nativeMemory(tx, actor.spaceId);
        for (const selection of input.memories) {
          const doc = await tx.memoryDocument.findFirst({
            where: {
              id: selection.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              OR: [
                { scope: "bot", botId: bot.id },
                { scope: "user", botId: null },
              ],
            },
          });
          assert(doc, "FORBIDDEN", "Selected memory is not owned by the source Bot/workspace");
          assert(
            String(doc.revision) === selection.revision,
            "SOURCE_CHANGED",
            "Selected memory changed; refresh the selection",
          );
          items.push({
            key: `memory:${doc.id}`,
            kind: "memory",
            title: doc.path,
            content: doc.content,
            description: null,
            files: null,
            sourceId: doc.id,
            sourceRevision: selection.revision,
            contentHash: hash(doc.content),
          });
        }
        for (const selection of input.skills) {
          if (selection.id.startsWith("handoff:")) {
            const row = await tx.experienceSkill.findFirst({
              where: {
                id: selection.id.slice("handoff:".length),
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: bot.id,
              },
            });
            assert(row, "FORBIDDEN", "Selected experience Skill does not belong to the source Bot");
            assert(
              String(row.revision) === selection.revision,
              "SOURCE_CHANGED",
              "Selected experience Skill changed",
            );
            const copy = experienceSkillDto(row);
            const safe = skillText(copy.content);
            const files = safeFiles(copy.files);
            items.push({
              key: `skill:${selection.id}`,
              kind: "skill",
              title: safe.name,
              content: safe.content,
              description: safe.description,
              files,
              sourceId: selection.id,
              sourceRevision: selection.revision,
              contentHash: hash({ ...safe, files }),
            });
            continue;
          }
          const skill = await tx.agentSkill.findFirst({
            where: { id: selection.id, spaceId: actor.spaceId, userId: actor.userId },
          });
          assert(skill, "FORBIDDEN", "Selected Skill is not owned by the source workspace");
          assert(
            skill.updatedAt.toISOString() === selection.revision,
            "SOURCE_CHANGED",
            "Selected Skill changed; refresh the selection",
          );
          const safe = skillText(skill.content);
          const files = safeFiles(skill.files);
          items.push({
            key: `skill:${skill.id}`,
            kind: "skill",
            title: safe.name,
            content: safe.content,
            description: safe.description,
            files,
            sourceId: skill.id,
            sourceRevision: selection.revision,
            contentHash: hash({ ...safe, files }),
          });
        }
        assert(
          items.length > 0 &&
            items.length <= 50 &&
            new Set(items.map((i) => i.key)).size === items.length,
          "INVALID_INPUT",
          "Select between 1 and 50 distinct items",
        );
        const snapshot = HandoffSnapshotSchema.parse({
          schemaVersion: 1,
          title: input.title,
          sourceBotName: bot.name,
          sourceSpaceName: space.name,
          sourceWorkspaceKind: space.kind,
          applicability: input.applicability,
          items,
        });
        assert(
          Buffer.byteLength(canonical(snapshot)) <= 512 * 1024,
          "INVALID_INPUT",
          "Experience package exceeds 512 KiB",
        );
        const id = randomUUID();
        const previous = input.previousPackageId
          ? await source(tx, actor, input.previousPackageId)
          : null;
        if (previous) {
          assert(
            previous.sourceBotId === bot.id &&
              previous.spaceId === actor.spaceId &&
              !previous.revokedAt,
            "INVALID_INPUT",
            "Versions must use the same active source",
          );
          assert(
            !(await tx.experiencePackage.findFirst({ where: { previousPackageId: previous.id } })),
            "CONFLICT",
            "This version already has a successor",
          );
        }
        const row = await tx.experiencePackage.create({
          data: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            sourceBotId: bot.id,
            requestId: input.requestId,
            requestHash,
            lineageId: previous?.lineageId ?? id,
            version: (previous?.version ?? 0) + 1,
            previousPackageId: previous?.id ?? null,
            snapshot: json(snapshot),
            contentHash: hash(snapshot),
          },
        });
        await event(tx, actor, id, "created", {
          version: row.version,
          contentHash: row.contentHash,
        });
        return dto(row);
      });
    },
    get: (actor: Actor, input: RpcInput<"experienceHandoff/get">) =>
      transaction(actor, async (tx) => dto(await source(tx, actor, input.packageId))),
    packages(actor: Actor, input: RpcInput<"experienceHandoff/packages">) {
      return transaction(actor, async (tx) => {
        const spaces = await tx.space.findMany({
          where: {
            deletingAt: null,
            isolationPending: false,
            memberships: { some: { userId: actor.userId, role: "owner" } },
          },
          select: { id: true },
        });
        const rows = await tx.experiencePackage.findMany({
          where: {
            userId: actor.userId,
            spaceId: { in: spaces.map((s) => s.id) },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          take: (input.limit ?? 50) + 1,
        });
        return {
          items: rows.slice(0, input.limit ?? 50).map(dto),
          nextCursor: rows.length > (input.limit ?? 50) ? rows[(input.limit ?? 50) - 1]!.id : null,
        };
      });
    },
    preview: (actor: Actor, input: RpcInput<"experienceHandoff/preview">) =>
      transaction(actor, (tx) => preview(tx, actor, input)),
    confirm(actor: Actor, input: RpcInput<"experienceHandoff/confirm">) {
      return transaction(actor, async (tx) => {
        const checked = await preview(tx, actor, input);
        if (checked.alreadyImported) return checked.alreadyImported;
        assert(
          checked.previewHash === input.previewHash,
          "STALE_PREVIEW",
          "Target changed; preview again",
        );
        assert(
          !checked.conflicts.length,
          "CONFLICT",
          "Resolve all name conflicts before importing",
        );
        const pkg = checked.package;
        const target = await requireIsolatedBot(tx, { ...actor, botId: input.targetBotId });
        const id = randomUUID();
        const receipt: HandoffReceipt = {
          id,
          packageId: pkg.id,
          packageVersion: pkg.version,
          packageHash: pkg.contentHash,
          sourceSpaceId: pkg.sourceSpaceId,
          sourceBotId: pkg.sourceBotId,
          sourceBotName: pkg.snapshot.sourceBotName,
          targetSpaceId: actor.spaceId,
          targetBotId: target.id,
          targetBotName: target.name,
          createdAt: new Date().toISOString(),
          items: [],
        };
        for (const choice of checked.plan) {
          const item = pkg.snapshot.items.find((i) => i.key === choice.itemKey)!;
          const copied = {
            itemKey: item.key,
            kind: item.kind,
            targetName: choice.targetName,
            targetId: null as string | null,
            initialRevision: null as number | null,
            status: "skipped" as "skipped" | "copied" | "pending",
          };
          if (choice.action === "copy") {
            if (item.kind === "skill") {
              const safe = skillText(item.content, choice.targetName);
              const skill = await tx.experienceSkill.create({
                data: {
                  id: randomUUID(),
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  botId: target.id,
                  importId: id,
                  itemKey: item.key,
                  name: choice.targetName,
                  payload: json({
                    description: safe.description,
                    content: safe.content,
                    files: item.files ?? {},
                  }),
                },
              });
              copied.targetId = skill.id;
              copied.status = "pending";
            } else {
              const doc = await tx.memoryDocument.create({
                data: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  botId: target.id,
                  scope: "bot",
                  path: choice.targetName,
                  content: item.content,
                },
              });
              await tx.memoryRevision.create({
                data: { documentId: doc.id, revision: 1, content: doc.content },
              });
              copied.targetId = doc.id;
              copied.status = "copied";
            }
            copied.initialRevision = 1;
          }
          receipt.items.push(copied);
        }
        await tx.experienceImport.create({
          data: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            sourceSpaceId: pkg.sourceSpaceId,
            sourceBotId: pkg.sourceBotId,
            targetBotId: target.id,
            packageId: pkg.id,
            planHash: hash(checked.plan),
            snapshot: json(pkg),
            receipt: json(receipt),
          },
        });
        await event(tx, actor, pkg.id, "imported", receipt, id);
        return receipt;
      });
    },
    history(actor: Actor, input: RpcInput<"experienceHandoff/history">) {
      return transaction(actor, async (tx) => {
        const rows = await tx.experienceImport.findMany({
          where: {
            userId: actor.userId,
            OR: [
              { spaceId: actor.spaceId, ...(input.botId ? { targetBotId: input.botId } : {}) },
              {
                sourceSpaceId: actor.spaceId,
                ...(input.botId ? { sourceBotId: input.botId } : {}),
              },
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          take: (input.limit ?? 50) + 1,
        });
        return {
          items: rows.slice(0, input.limit ?? 50).map((r) => HandoffReceiptSchema.parse(r.receipt)),
          nextCursor: rows.length > (input.limit ?? 50) ? rows[(input.limit ?? 50) - 1]!.id : null,
        };
      });
    },
    importDetail(actor: Actor, input: RpcInput<"experienceHandoff/importDetail">) {
      return transaction(actor, async (tx) => {
        const row = await tx.experienceImport.findFirst({
          where: {
            id: input.importId,
            userId: actor.userId,
            OR: [{ spaceId: actor.spaceId }, { sourceSpaceId: actor.spaceId }],
          },
        });
        assert(row, "NOT_FOUND", "Experience import is unavailable");
        return {
          receipt: HandoffReceiptSchema.parse(row.receipt),
          package: HandoffPackageSchema.parse(row.snapshot),
        };
      });
    },
    revoke(actor: Actor, input: RpcInput<"experienceHandoff/revoke">) {
      return transaction(actor, async (tx) => {
        const row = await source(tx, actor, input.packageId);
        assert(row.spaceId === actor.spaceId, "FORBIDDEN", "Revoke in the source workspace");
        if (row.revokedAt) return dto(row);
        const revoked = await tx.experiencePackage.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });
        await event(tx, actor, row.id, "revoked", { contentHash: row.contentHash });
        return dto(revoked);
      });
    },
    skills(actor: Actor, input: RpcInput<"experienceHandoff/skills">) {
      return transaction(actor, async (tx) => {
        await requireIsolatedBot(tx, { ...actor, botId: input.botId });
        const rows = await tx.experienceSkill.findMany({
          where: { spaceId: actor.spaceId, userId: actor.userId, botId: input.botId },
          orderBy: { name: "asc" },
        });
        return Promise.all(
          rows.map(async (row) => {
            const skill = experienceSkillDto(row);
            if (!row.enabledAt) return skill;
            const collision = await skillCollision(tx, actor, row.botId, row.name, row.id);
            return {
              ...skill,
              blockedReason:
                collision.native || collision.copy || reservedNames.has(row.name.toLowerCase())
                  ? ("name_conflict" as const)
                  : null,
            };
          }),
        );
      });
    },
    updateSkill(actor: Actor, input: RpcInput<"experienceHandoff/updateSkill">) {
      return transaction(actor, async (tx) => {
        const row = await tx.experienceSkill.findFirst({
          where: { id: input.skillId, spaceId: actor.spaceId, userId: actor.userId },
        });
        assert(row, "NOT_FOUND", "Imported Skill is unavailable");
        await requireIsolatedBot(tx, { ...actor, botId: row.botId });
        assert(
          row.revision === input.expectedRevision,
          "CONFLICT",
          "Imported Skill changed; reload before editing",
        );
        const payload = experienceSkillDto(row);
        const safe = skillText(input.content ?? payload.content);
        assert(
          safe.name === row.name,
          "INVALID_INPUT",
          "Imported Skill names cannot be changed after import",
        );
        if (input.enabled ?? Boolean(row.enabledAt)) {
          const collision = await skillCollision(tx, actor, row.botId, row.name, row.id);
          assert(
            !collision.native && !collision.copy && !reservedNames.has(row.name.toLowerCase()),
            "CONFLICT",
            "A Skill with this name is already available",
          );
        }
        const updated = await tx.experienceSkill.update({
          where: { id: row.id },
          data: {
            payload: json({
              content: safe.content,
              description: safe.description,
              files: payload.files,
            }),
            enabledAt:
              input.enabled === undefined
                ? row.enabledAt
                : input.enabled
                  ? (row.enabledAt ?? new Date())
                  : null,
            revision: { increment: 1 },
          },
        });
        const receipt = await tx.experienceImport.findUniqueOrThrow({
          where: { id: row.importId },
        });
        await event(
          tx,
          actor,
          receipt.packageId,
          "skill.updated",
          { before: payload, after: experienceSkillDto(updated) },
          row.importId,
        );
        return experienceSkillDto(updated);
      });
    },
  };
}

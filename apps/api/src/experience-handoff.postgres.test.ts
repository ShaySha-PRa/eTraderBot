import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor, RpcInput } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import {
  contentEncryptionOf,
  createDb,
  createPool,
  migrateContent,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listBotSecrets,
  revealBotSecret,
  storeBotSecret,
} from "../../../packages/adapters/src/bot-secrets.js";
import { BUILTIN_AGENT_SKILLS } from "../../../packages/adapters/src/builtin-skills.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import {
  listAgentSkillRecords,
  skillReadFromTool,
  skillUpdateFromTool,
} from "../../../packages/adapters/src/skill-tools.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("fixed-version experience handoff (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof createPool>;
  const system = <T>(fn: () => Promise<T>) =>
    runAsSystem("isolated experience handoff fixture/assertion", fn);
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, { encryptContent: true });
    admin = createPool(process.env.DATABASE_MIGRATION_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await admin?.end();
  });
  function rootClient(actor: Actor, confirmed = true) {
    return createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        tradingClock: () => new Date("2030-05-01T00:00:00.000Z"),
        auth: { hasRecentIdentityConfirmation: async () => confirmed },
      } as unknown as RouterDeps),
      { context: { actor, sessionId: "synthetic-handoff-session" } },
    );
  }
  const client = (actor: Actor, confirmed = true) => rootClient(actor, confirmed).experienceHandoff;
  async function fixture() {
    return system(async () => {
      const userId = randomUUID(),
        org = randomUUID();
      const base = { userId, email: `${userId}@example.test`, isDeploymentOwner: false };
      await db.prisma.user.create({
        data: { id: userId, email: base.email, name: "Synthetic owner" },
      });
      await db.prisma.organization.create({
        data: { id: org, name: "Synthetic", slug: org, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      async function space(kind: "trading" | "general", name: string) {
        const row = await db.prisma.space.create({
          data: { id: randomUUID(), organizationId: org, createdByUserId: userId, name, kind },
        });
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId: org,
            spaceId: row.id,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        const actor: Actor = { ...base, spaceId: row.id };
        const bot = await db.prisma.bot.create({
          data: {
            spaceId: row.id,
            userId,
            name: `${name} Bot`,
            color: "blue",
            tradingRole: kind === "trading" ? "spot" : null,
          },
        });
        return { actor, bot, rpc: client(actor) };
      }
      const from = await space("trading", "Source"),
        to = await space("trading", "Target"),
        general = await space("general", "General");
      const memory = await db.prisma.memoryDocument.create({
        data: {
          spaceId: from.actor.spaceId,
          userId,
          botId: from.bot.id,
          scope: "bot",
          path: "lessons.md",
          content: "Synthetic lesson version one",
        },
      });
      await db.prisma.memoryRevision.create({
        data: { documentId: memory.id, revision: 1, content: memory.content },
      });
      const skill = await db.prisma.agentSkill.create({
        data: {
          spaceId: from.actor.spaceId,
          userId,
          name: "lesson",
          description: "Synthetic lesson",
          content: buildSkillMd({
            name: "lesson",
            description: "Synthetic lesson",
            body: "Check evidence before summarizing.",
            frontmatter: { "allowed-tools": ["trade_execute"], permission: "admin" },
          }),
          files: { "references/guide.md": "Synthetic reference" },
        },
      });
      const input: RpcInput<"experienceHandoff/create"> = {
        requestId: randomUUID(),
        sourceBotId: from.bot.id,
        title: "Synthetic experience",
        applicability: {
          conditions: ["Simulation only"],
          limitations: ["No live trading authorization"],
        },
        summaries: [{ title: "Selected summary", content: "User-selected synthetic summary" }],
        memories: [{ id: memory.id, revision: "1" }],
        skills: [{ id: skill.id, revision: skill.updatedAt.toISOString() }],
      };
      const create = () => from.rpc.create(input);
      async function prepare(target = to) {
        const pkg = await create();
        const preview = await target.rpc.preview({ packageId: pkg.id, targetBotId: target.bot.id });
        const confirmation = {
          packageId: pkg.id,
          targetBotId: target.bot.id,
          plan: preview.plan,
          previewHash: preview.previewHash,
        };
        return { pkg, preview, confirmation };
      }
      return { from, to, general, memory, skill, input, create, prepare };
    });
  }
  it("creates an immutable version, copies selected material, keeps Skills pending and transfers no authority", async () => {
    const f = await fixture();
    const before = await system(() =>
      db.prisma.bot.findUniqueOrThrow({ where: { id: f.to.bot.id } }),
    );
    const { pkg, preview, confirmation } = await f.prepare();
    expect(pkg.version).toBe(1);
    expect(preview.conflicts).toEqual([]);
    expect(pkg.snapshot.items.find((i) => i.kind === "skill")?.content).not.toContain(
      "allowed-tools",
    );
    const receipt = await f.to.rpc.confirm(confirmation);
    expect(receipt.items.map((i) => i.status)).toEqual(["copied", "copied", "pending"]);
    const copies = await f.to.rpc.skills({ botId: f.to.bot.id });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.enabledAt).toBeNull();
    expect(
      await runAsTenant(f.to.actor, () =>
        listAgentSkillRecords(db.prisma, { ...f.to.actor, botId: f.to.bot.id }),
      ),
    ).not.toContainEqual(expect.objectContaining({ id: `handoff:${copies[0]?.id}` }));
    await system(async () => {
      expect(await db.prisma.bot.findUniqueOrThrow({ where: { id: f.to.bot.id } })).toEqual(before);
      const doc = await db.prisma.memoryDocument.findUniqueOrThrow({
        where: { id: receipt.items[1]!.targetId! },
        include: { revisions: true },
      });
      expect(doc.content).toBe(f.memory.content);
      expect(doc.botId).toBe(f.to.bot.id);
      expect(doc.revisions).toHaveLength(1);
      expect(
        await db.prisma.tradingGrant.count({ where: { desk: { spaceId: f.to.actor.spaceId } } }),
      ).toBe(0);
      expect(await db.prisma.agentSkill.count({ where: { spaceId: f.to.actor.spaceId } })).toBe(0);
      expect(await db.prisma.task.count({ where: { spaceId: f.to.actor.spaceId } })).toBe(0);
      expect(await db.prisma.run.count({ where: { spaceId: f.to.actor.spaceId } })).toBe(0);
    });
  });
  it("activates a Skill only for the selected Bot and allows independent, version-checked edits", async () => {
    const f = await fixture(),
      { confirmation, pkg } = await f.prepare(f.general);
    const receipt = await f.general.rpc.confirm(confirmation);
    const skillId = receipt.items.find((i) => i.kind === "skill")!.targetId!;
    let copy = (await f.general.rpc.skills({ botId: f.general.bot.id }))[0]!;
    copy = await f.general.rpc.updateSkill({
      skillId,
      expectedRevision: 1,
      enabled: true,
      content: buildSkillMd({
        name: copy.name,
        description: "Target independent description",
        body: "Target independent text",
      }),
    });
    expect(copy.enabledAt).not.toBeNull();
    expect(copy.revision).toBe(2);
    const owner = { ...f.general.actor, botId: f.general.bot.id };
    const catalog = await runAsTenant(owner, () => listAgentSkillRecords(db.prisma, owner));
    expect(catalog).toContainEqual(
      expect.objectContaining({ id: `handoff:${skillId}`, content: copy.content }),
    );
    // Omitting file reads the main SKILL.md; file selects an auxiliary reference.
    const main = await runAsTenant(owner, () =>
      skillReadFromTool(db.prisma, owner, { skillId: `handoff:${skillId}` }),
    );
    expect(main).toMatchObject({ content: copy.content, readOnly: true, importId: receipt.id });
    expect(main.content).toContain("Target independent text");
    expect(main.content).not.toContain("Check evidence before summarizing.");
    expect(
      await runAsTenant(f.to.actor, () =>
        skillReadFromTool(
          db.prisma,
          { ...f.to.actor, botId: f.to.bot.id },
          { skillId: `handoff:${skillId}` },
        ),
      ),
    ).toHaveProperty("error");
    expect(
      await runAsTenant(owner, () =>
        skillReadFromTool(db.prisma, owner, {
          skillId: `handoff:${skillId}`,
          file: "references/guide.md",
        }),
      ),
    ).toMatchObject({ content: "Synthetic reference" });
    expect(
      await runAsTenant(owner, () =>
        skillUpdateFromTool(db.prisma, owner, { skillId: `handoff:${skillId}`, body: "forbidden" }),
      ),
    ).toHaveProperty("error");
    await expect(
      f.general.rpc.updateSkill({ skillId, expectedRevision: 1, enabled: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await f.from.rpc.get({ packageId: pkg.id })).snapshot.items.find((i) => i.kind === "skill")
        ?.content,
    ).not.toContain("Target independent text");
    await f.general.rpc.updateSkill({ skillId, expectedRevision: 2, enabled: false });
    expect(
      await runAsTenant(owner, () => listAgentSkillRecords(db.prisma, owner)),
    ).not.toContainEqual(expect.objectContaining({ id: `handoff:${skillId}` }));
    expect(
      await runAsTenant(owner, () =>
        skillReadFromTool(db.prisma, owner, { skillId: `handoff:${skillId}` }),
      ),
    ).toHaveProperty("error");
  });
  it("makes concurrent creation and confirmation idempotent and rejects reuse with a different plan", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.create(), f.create()]);
    expect(two.id).toBe(one.id);
    const { confirmation } = await f.prepare();
    const [a, b] = await Promise.all([
      f.to.rpc.confirm(confirmation),
      f.to.rpc.confirm(confirmation),
    ]);
    expect(b).toEqual(a);
    expect(await f.to.rpc.confirm(confirmation)).toEqual(a);
    await expect(f.from.rpc.create({ ...f.input, title: "Changed" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      f.to.rpc.confirm({
        ...confirmation,
        plan: confirmation.plan.map((p, i) => (i ? p : { ...p, action: "skip" })),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.to.rpc.history({})).items).toHaveLength(1);
    expect(
      (await f.to.rpc.preview({ packageId: one.id, targetBotId: f.to.bot.id })).alreadyImported,
    ).toEqual(a);
  });
  it("detects stale previews, reports conflicts, and requires explicit rename/skip without overwriting", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    await system(() =>
      db.prisma.memoryDocument.create({
        data: {
          spaceId: f.to.actor.spaceId,
          userId: f.to.actor.userId,
          botId: f.to.bot.id,
          scope: "bot",
          path: confirmation.plan[0]!.targetName,
          content: "Original target content",
        },
      }),
    );
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "STALE_PREVIEW" },
    });
    const conflict = await f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id });
    expect(conflict.conflicts).toHaveLength(1);
    await expect(
      f.to.rpc.confirm({ ...confirmation, previewHash: conflict.previewHash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const plan = confirmation.plan.map((p, i) =>
      i === 0
        ? { ...p, targetName: "handoff/renamed.md" }
        : i === 1
          ? { ...p, action: "skip" as const }
          : p,
    );
    const resolved = await f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id, plan });
    const imported = await f.to.rpc.confirm({
      ...confirmation,
      plan,
      previewHash: resolved.previewHash,
    });
    expect(
      (await f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id })).alreadyImported,
    ).toEqual(imported);
    expect(imported.items[1]).toMatchObject({
      status: "skipped",
      targetId: null,
      initialRevision: null,
    });
    expect(
      await system(() =>
        db.prisma.memoryDocument.findFirst({
          where: { botId: f.to.bot.id, path: confirmation.plan[0]!.targetName },
        }),
      ),
    ).toMatchObject({ content: "Original target content", revision: 1 });
  });
  it("rolls back every copy on a late database failure and retries the same confirmation", async () => {
    const f = await fixture(),
      { confirmation, pkg } = await f.prepare();
    // Only this disposable test database: fail after memory and Skill creation, at receipt insertion.
    await system(() =>
      admin.query(
        `ALTER TABLE experience_imports ADD CONSTRAINT synthetic_handoff_failure CHECK ("packageId" <> '${pkg.id}')`,
      ),
    );
    try {
      await expect(f.to.rpc.confirm(confirmation)).rejects.toThrow();
      await system(async () => {
        expect(await db.prisma.memoryDocument.count({ where: { botId: f.to.bot.id } })).toBe(0);
        expect(await db.prisma.experienceSkill.count({ where: { botId: f.to.bot.id } })).toBe(0);
        expect(await db.prisma.experienceImport.count({ where: { packageId: pkg.id } })).toBe(0);
      });
    } finally {
      await system(() =>
        admin.query("ALTER TABLE experience_imports DROP CONSTRAINT synthetic_handoff_failure"),
      );
    }
    const receipt = await f.to.rpc.confirm(confirmation);
    expect(receipt.items).toHaveLength(3);
    expect((await f.to.rpc.history({})).items).toEqual([receipt]);
  });
  it("retains snapshots and history across source edits, independent target edits and Bot deletion", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    await system(async () => {
      await db.prisma.memoryDocument.update({
        where: { id: f.memory.id },
        data: { content: "Source version two", revision: 2 },
      });
      await db.prisma.memoryDocument.update({
        where: { id: receipt.items[1]!.targetId! },
        data: { content: "Target version two", revision: 2 },
      });
    });
    const v2 = await f.from.rpc.create({
      ...f.input,
      requestId: randomUUID(),
      previousPackageId: pkg.id,
      memories: [{ id: f.memory.id, revision: "2" }],
    });
    expect(v2).toMatchObject({ version: 2, lineageId: pkg.lineageId, previousPackageId: pkg.id });
    expect(
      (await f.from.rpc.get({ packageId: pkg.id })).snapshot.items.find((i) => i.kind === "memory")
        ?.content,
    ).toBe(f.memory.content);
    await expect(
      f.from.rpc.create({
        ...f.input,
        requestId: randomUUID(),
        previousPackageId: pkg.id,
        memories: [{ id: f.memory.id, revision: "2" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await system(async () => {
      await db.prisma.bot.delete({ where: { id: f.from.bot.id } });
      await db.prisma.bot.delete({ where: { id: f.to.bot.id } });
    });
    expect((await f.from.rpc.get({ packageId: pkg.id })).snapshot.items).toHaveLength(3);
    expect((await f.to.rpc.history({ botId: f.to.bot.id })).items).toEqual([receipt]);
    expect((await f.from.rpc.history({ botId: f.from.bot.id })).items).toEqual([receipt]);
  });
  it("refuses cross-user, wrong-space, revoked membership and archived Bot requests at the server", async () => {
    const f = await fixture(),
      other = await fixture(),
      { pkg, confirmation } = await f.prepare();
    await expect(other.to.rpc.get({ packageId: pkg.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.to.rpc.preview({ packageId: pkg.id, targetBotId: other.to.bot.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.general.rpc.confirm(confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await system(() =>
      db.prisma.spaceMember.updateMany({
        where: { spaceId: f.from.actor.spaceId, userId: f.from.actor.userId },
        data: { role: "member" },
      }),
    );
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.to.rpc.packages({})).items).not.toContainEqual(
      expect.objectContaining({ id: pkg.id }),
    );
    await system(() =>
      db.prisma.spaceMember.updateMany({
        where: { spaceId: f.from.actor.spaceId, userId: f.from.actor.userId },
        data: { role: "owner" },
      }),
    );
    await system(() =>
      db.prisma.bot.update({ where: { id: f.to.bot.id }, data: { archivedAt: new Date() } }),
    );
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.to.rpc.history({})).items).toEqual([]);
  });
  it("does not let a different source Bot select another Bot's memory or stale versions", async () => {
    const f = await fixture();
    const peer = await system(() =>
      db.prisma.bot.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          name: "Peer",
          color: "blue",
          tradingRole: "review",
        },
      }),
    );
    await expect(f.from.rpc.create({ ...f.input, sourceBotId: peer.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.from.rpc.create({ ...f.input, memories: [{ id: f.memory.id, revision: "2" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "SOURCE_CHANGED" } });
    await expect(
      f.from.rpc.create({ ...f.input, skills: [{ id: f.skill.id, revision: "old" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.from.rpc.create({ ...f.input, memories: [...f.input.memories, ...f.input.memories] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("revocation blocks future imports but preserves independent copies, receipts and idempotent acknowledgements", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    const revoked = await f.from.rpc.revoke({ packageId: pkg.id });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(
      f.general.rpc.preview({ packageId: pkg.id, targetBotId: f.general.bot.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "PACKAGE_REVOKED" } });
    expect(await f.to.rpc.confirm(confirmation)).toEqual(receipt);
    expect((await f.to.rpc.history({})).items).toEqual([receipt]);
    expect(
      await system(() => db.prisma.memoryDocument.count({ where: { botId: f.to.bot.id } })),
    ).toBe(2);
    expect(
      await system(() =>
        db.prisma.experienceHandoffEvent.count({ where: { packageId: pkg.id, kind: "revoked" } }),
      ),
    ).toBe(1);
    await f.from.rpc.revoke({ packageId: pkg.id });
    expect(
      await system(() =>
        db.prisma.experienceHandoffEvent.count({ where: { packageId: pkg.id, kind: "revoked" } }),
      ),
    ).toBe(1);
  });
  it("enforces database RLS and encrypts handoff material at rest", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    expect(
      await runAsTenant(f.to.actor, () =>
        db.prisma.experiencePackage.findMany({ where: { id: pkg.id } }),
      ),
    ).toEqual([]);
    expect(
      await runAsTenant(f.general.actor, () =>
        db.prisma.experienceImport.findMany({ where: { id: receipt.id } }),
      ),
    ).toEqual([]);
    await system(async () => {
      const raw = await db.pool.query(
        "SELECT snapshot::text FROM experience_packages WHERE id=$1",
        [pkg.id],
      );
      expect(raw.rows[0].snapshot).not.toContain("Synthetic lesson version one");
      expect(raw.rows[0].snapshot).not.toContain("User-selected synthetic summary");
      const stored = await db.prisma.experienceImport.findUniqueOrThrow({
        where: { id: receipt.id },
      });
      expect(stored.snapshot).toMatchObject({ snapshot: { title: pkg.snapshot.title } });
    });
  });
  it("requires user identity confirmation on mutations and rejects injected authority fields", async () => {
    const f = await fixture();
    await expect(client(f.from.actor, false).create(f.input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      f.from.rpc.create({
        ...f.input,
        tradingRole: "spot",
      } as RpcInput<"experienceHandoff/create">),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { confirmation } = await f.prepare();
    await expect(client(f.to.actor, false).confirm(confirmation)).rejects.toMatchObject({
      status: 403,
    });
  });
  describe.each([false, true])("Skill content authorization (enabled=%s)", (active) => {
    it.each([
      "unconfirmed identity",
      "another owner in the same workspace",
      "wrong workspace",
      "revoked workspace membership",
      "workspace owner downgraded to member",
      "archived Bot",
      "Bot reassigned to another owner",
    ])("refuses %s without changing the copy or history", async (scenario) => {
      const f = await fixture(),
        { pkg, confirmation } = await f.prepare();
      const receipt = await f.to.rpc.confirm(confirmation);
      const skillId = receipt.items.find((i) => i.kind === "skill")!.targetId!;
      let copy = (await f.to.rpc.skills({ botId: f.to.bot.id }))[0]!;
      if (active)
        copy = await f.to.rpc.updateSkill({ skillId, expectedRevision: 1, enabled: true });
      const enabledAt = copy.enabledAt;
      // Positive control: valid content-only edits preserve the existing activation state.
      copy = await f.to.rpc.updateSkill({
        skillId,
        expectedRevision: copy.revision,
        content: buildSkillMd({
          name: copy.name,
          description: "Authorized target edit",
          body: "Retain this authorized target text.",
        }),
      });
      expect(copy.content).toContain("Retain this authorized target text.");
      expect(copy.enabledAt).toEqual(enabledAt);
      expect(copy.revision).toBe(active ? 3 : 2);
      const detail = await f.to.rpc.importDetail({ importId: receipt.id });
      // Inspect persisted state even after the original caller loses read access.
      const snapshot = () =>
        system(async () => ({
          copy: await db.prisma.experienceSkill.findUniqueOrThrow({ where: { id: skillId } }),
          receipt: await db.prisma.experienceImport.findUniqueOrThrow({
            where: { id: receipt.id },
          }),
          package: await db.prisma.experiencePackage.findUniqueOrThrow({ where: { id: pkg.id } }),
          events: await db.prisma.experienceHandoffEvent.findMany({
            where: { packageId: pkg.id },
            orderBy: { id: "asc" },
          }),
        }));
      const before = await snapshot();
      let rpc = f.to.rpc;
      let rejection = { code: "FORBIDDEN", status: 403 };
      if (scenario === "unconfirmed identity") {
        rpc = client(f.to.actor, false);
        rejection = { code: "IDENTITY_CONFIRMATION_REQUIRED", status: 403 };
      } else if (
        scenario === "another owner in the same workspace" ||
        scenario === "Bot reassigned to another owner"
      ) {
        const other = await fixture();
        await system(async () => {
          const space = await db.prisma.space.findUniqueOrThrow({
            where: { id: f.to.actor.spaceId },
          });
          await db.prisma.member.create({
            data: {
              id: randomUUID(),
              organizationId: space.organizationId,
              userId: other.to.actor.userId,
              role: "member",
              createdAt: new Date(),
            },
          });
          await db.prisma.spaceMember.create({
            data: {
              id: randomUUID(),
              organizationId: space.organizationId,
              spaceId: space.id,
              userId: other.to.actor.userId,
              role: "owner",
              createdAt: new Date(),
            },
          });
          if (scenario === "Bot reassigned to another owner")
            await db.prisma.bot.update({
              where: { id: f.to.bot.id },
              data: { userId: other.to.actor.userId },
            });
        });
        if (scenario === "another owner in the same workspace") {
          rpc = client({ ...other.to.actor, spaceId: f.to.actor.spaceId });
          rejection = { code: "NOT_FOUND", status: 404 };
        }
      } else if (scenario === "wrong workspace") {
        rpc = f.general.rpc;
        rejection = { code: "NOT_FOUND", status: 404 };
      } else if (scenario === "revoked workspace membership") {
        await system(() =>
          db.prisma.spaceMember.deleteMany({
            where: { spaceId: f.to.actor.spaceId, userId: f.to.actor.userId },
          }),
        );
      } else if (scenario === "workspace owner downgraded to member") {
        await system(() =>
          db.prisma.spaceMember.updateMany({
            where: { spaceId: f.to.actor.spaceId, userId: f.to.actor.userId },
            data: { role: "member" },
          }),
        );
      } else if (scenario === "archived Bot") {
        await system(() =>
          db.prisma.bot.update({ where: { id: f.to.bot.id }, data: { archivedAt: new Date() } }),
        );
      }
      await expect(
        rpc.updateSkill({
          skillId,
          expectedRevision: copy.revision,
          content: buildSkillMd({
            name: copy.name,
            description: "Unauthorized target edit",
            body: "This text must never replace the authorized content.",
          }),
        }),
      ).rejects.toMatchObject(rejection);
      // Exact row/event comparisons include payload, revision, enabledAt and timestamps.
      expect(await snapshot()).toEqual(before);
      expect(await f.from.rpc.get({ packageId: pkg.id })).toEqual(pkg);
      // Import history remains readable through the still-authorized source workspace.
      expect(await f.from.rpc.importDetail({ importId: receipt.id })).toEqual(detail);
    });
  });
  it("keeps an imported historical snapshot readable after source access is lost, with no new source reads", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    await system(() =>
      db.prisma.spaceMember.deleteMany({
        where: { spaceId: f.from.actor.spaceId, userId: f.from.actor.userId },
      }),
    );
    await expect(f.to.rpc.get({ packageId: pkg.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.to.rpc.importDetail({ importId: receipt.id })).toEqual({
      receipt,
      package: pkg,
    });
    await expect(f.general.rpc.importDetail({ importId: receipt.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("can hand off an edited imported Skill again without carrying its enabled state", async () => {
    const f = await fixture(),
      { confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    const id = receipt.items.find((i) => i.kind === "skill")!.targetId!;
    await f.to.rpc.updateSkill({ skillId: id, expectedRevision: 1, enabled: true });
    const selected = (await f.to.rpc.catalog({ sourceBotId: f.to.bot.id })).find(
      (i) => i.id === `handoff:${id}`,
    )!;
    expect(selected.revision).toBe("2");
    const pkg = await f.to.rpc.create({
      ...f.input,
      requestId: randomUUID(),
      sourceBotId: f.to.bot.id,
      summaries: [],
      memories: [],
      skills: [{ id: selected.id, revision: selected.revision }],
    });
    const preview = await f.general.rpc.preview({
      packageId: pkg.id,
      targetBotId: f.general.bot.id,
    });
    await f.general.rpc.confirm({
      packageId: pkg.id,
      targetBotId: f.general.bot.id,
      plan: preview.plan,
      previewHash: preview.previewHash,
    });
    expect((await f.general.rpc.skills({ botId: f.general.bot.id }))[0]?.enabledAt).toBeNull();
    expect(pkg.snapshot.items[0]?.sourceId).toBe(`handoff:${id}`);
    const peer = await system(() =>
      db.prisma.bot.create({
        data: {
          spaceId: f.to.actor.spaceId,
          userId: f.to.actor.userId,
          name: "Same workspace peer",
          color: "blue",
          tradingRole: "risk",
        },
      }),
    );
    const owner = { ...f.to.actor, botId: peer.id };
    expect(
      await runAsTenant(owner, () =>
        skillReadFromTool(db.prisma, owner, { skillId: `handoff:${id}` }),
      ),
    ).toHaveProperty("error");
  });
  it("rejects incomplete plans, duplicate targets and traversal before writing", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const input = { packageId: pkg.id, targetBotId: f.to.bot.id };
    await expect(
      f.to.rpc.preview({ ...input, plan: confirmation.plan.slice(1) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.to.rpc.preview({
        ...input,
        plan: confirmation.plan.map((p, i) => (i ? p : { ...p, targetName: "../escape.md" })),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const duplicate = await f.to.rpc.preview({
      ...input,
      plan: confirmation.plan.map((p, i) =>
        i === 1 ? { ...p, targetName: confirmation.plan[0]!.targetName } : p,
      ),
    });
    expect(duplicate.conflicts).toContainEqual({
      itemKey: confirmation.plan[1]!.itemKey,
      reason: "DUPLICATE_TARGET",
    });
    await expect(
      f.to.rpc.confirm({ ...input, plan: duplicate.plan, previewHash: duplicate.previewHash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await system(() =>
      db.prisma.spaceMember.updateMany({
        where: { spaceId: f.to.actor.spaceId, userId: f.to.actor.userId },
        data: { role: "member" },
      }),
    );
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("permits explicitly selected shared native memory and safely rejects external-memory writes", async () => {
    const f = await fixture();
    const shared = await system(() =>
      db.prisma.memoryDocument.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          scope: "user",
          path: "shared.md",
          content: "Explicitly selected shared lesson",
        },
      }),
    );
    const pkg = await f.from.rpc.create({
      ...f.input,
      memories: [{ id: shared.id, revision: "1" }],
    });
    expect(pkg.snapshot.items.find((i) => i.kind === "memory")?.sourceId).toBe(shared.id);
    await system(async () => {
      const secret = await db.prisma.secret.create({
        data: {
          spaceId: f.to.actor.spaceId,
          userId: f.to.actor.userId,
          kind: "synthetic-memory-test",
          ciphertext: "synthetic-placeholder",
        },
      });
      await db.prisma.spaceMemoryConfig.create({
        data: {
          spaceId: f.to.actor.spaceId,
          userId: f.to.actor.userId,
          provider: "synthetic",
          settings: {},
          secretId: secret.id,
        },
      });
    });
    await expect(
      f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "MEMORY_PROVIDER_UNSUPPORTED" },
    });
    const plan = pkg.snapshot.items.map((i, index) => ({
      itemKey: i.key,
      action: i.kind === "skill" ? ("copy" as const) : ("skip" as const),
      targetName: i.kind === "skill" ? "external-skill-copy" : `skip-${index}.md`,
    }));
    const preview = await f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id, plan });
    expect(preview.conflicts).toEqual([]);
  });
  it("reports builtin and shared Skill conflicts and never silently shadows an imported copy", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const plan = confirmation.plan.map((p) =>
      p.itemKey.startsWith("skill:")
        ? { ...p, targetName: BUILTIN_AGENT_SKILLS[0]!.name.toLowerCase() }
        : p,
    );
    const collision = await f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id, plan });
    expect(collision.conflicts).toContainEqual(
      expect.objectContaining({ reason: "BUILTIN_SKILL_NAME" }),
    );
    const receipt = await f.to.rpc.confirm(confirmation);
    const id = receipt.items.find((i) => i.kind === "skill")!.targetId!;
    const copy = await f.to.rpc.updateSkill({ skillId: id, expectedRevision: 1, enabled: true });
    await system(() =>
      db.prisma.agentSkill.create({
        data: {
          spaceId: f.to.actor.spaceId,
          userId: f.to.actor.userId,
          name: copy.name,
          description: "Later shared Skill",
          content: buildSkillMd({
            name: copy.name,
            description: "Later shared Skill",
            body: "Different shared body",
          }),
        },
      }),
    );
    expect((await f.to.rpc.skills({ botId: f.to.bot.id }))[0]).toMatchObject({
      blockedReason: "name_conflict",
      content: copy.content,
    });
    const owner = { ...f.to.actor, botId: f.to.bot.id };
    expect(
      await runAsTenant(owner, () => listAgentSkillRecords(db.prisma, owner)),
    ).not.toContainEqual(expect.objectContaining({ id: `handoff:${id}` }));
    expect(
      await runAsTenant(owner, () =>
        skillReadFromTool(db.prisma, owner, { skillId: `handoff:${id}` }),
      ),
    ).toHaveProperty("error");
    await expect(
      f.to.rpc.updateSkill({ skillId: id, expectedRevision: 2, enabled: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.to.rpc.importDetail({ importId: receipt.id })).package.contentHash).toBe(
      pkg.contentHash,
    );
  });

  it("preserves hashes, versions and source history across content-key rotation", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    await system(async () => {
      const before = await db.pool.query(
        "SELECT snapshot::text FROM experience_packages WHERE id=$1",
        [pkg.id],
      );
      const ring = contentEncryptionOf(db.prisma)!.ring;
      await ring.rotate(f.from.actor.spaceId);
      await ring.rotate(f.to.actor.spaceId);
      await migrateContent(db.prisma, { mode: "reencrypt" });
      const after = await db.pool.query(
        "SELECT snapshot::text FROM experience_packages WHERE id=$1",
        [pkg.id],
      );
      expect(after.rows[0].snapshot).not.toEqual(before.rows[0].snapshot);
    });
    expect(await f.from.rpc.get({ packageId: pkg.id })).toEqual(pkg);
    expect(await f.to.rpc.importDetail({ importId: receipt.id })).toEqual({
      package: pkg,
      receipt,
    });
    expect((await f.to.rpc.skills({ botId: f.to.bot.id }))[0]?.revision).toBe(1);
  });

  it("paginates package and import history newest first without repeating versions", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const first = await f.to.rpc.confirm(confirmation);
    const next = await f.from.rpc.create({
      ...f.input,
      requestId: randomUUID(),
      previousPackageId: pkg.id,
    });
    const preview = await f.to.rpc.preview({ packageId: next.id, targetBotId: f.to.bot.id });
    const second = await f.to.rpc.confirm({
      packageId: next.id,
      targetBotId: f.to.bot.id,
      plan: preview.plan,
      previewHash: preview.previewHash,
    });
    const packages = await f.to.rpc.packages({ limit: 1 });
    expect(packages.items.map((p) => p.id)).toEqual([next.id]);
    expect(
      (await f.to.rpc.packages({ limit: 1, cursor: packages.nextCursor! })).items.map((p) => p.id),
    ).toEqual([pkg.id]);
    const history = await f.to.rpc.history({ limit: 1 });
    expect(history.items).toEqual([second]);
    expect((await f.to.rpc.history({ limit: 1, cursor: history.nextCursor! })).items).toEqual([
      first,
    ]);
  });

  it("distinguishes same-named Bot and shared memories by stable catalog source types", async () => {
    const f = await fixture();
    const { shared, peerMemory } = await system(async () => {
      const shared = await db.prisma.memoryDocument.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          scope: "user",
          path: f.memory.path,
          content: "Synthetic shared lesson",
        },
      });
      const peer = await db.prisma.bot.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          name: "Source peer",
          color: "blue",
          tradingRole: "risk",
        },
      });
      const peerMemory = await db.prisma.memoryDocument.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          botId: peer.id,
          scope: "bot",
          path: f.memory.path,
          content: "Another Bot's private lesson",
        },
      });
      return { shared, peerMemory };
    });
    const catalog = await f.from.rpc.catalog({ sourceBotId: f.from.bot.id });
    expect(catalog).toEqual(
      expect.arrayContaining([
        {
          id: f.memory.id,
          kind: "memory",
          sourceType: "bot_memory",
          title: f.memory.path,
          revision: "1",
        },
        {
          id: shared.id,
          kind: "memory",
          sourceType: "shared_memory",
          title: f.memory.path,
          revision: "1",
        },
        {
          id: f.skill.id,
          kind: "skill",
          sourceType: "workspace_skill",
          title: f.skill.name,
          revision: f.skill.updatedAt.toISOString(),
        },
      ]),
    );
    expect(catalog.some((item) => item.id === peerMemory.id)).toBe(false);
    const { confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    const importedSkill = receipt.items.find((item) => item.kind === "skill")!;
    expect(await f.to.rpc.catalog({ sourceBotId: f.to.bot.id })).toContainEqual({
      id: `handoff:${importedSkill.targetId}`,
      kind: "skill",
      sourceType: "imported_skill",
      title: importedSkill.targetName,
      revision: "1",
    });
  });

  it("reads and imports a legacy v1 snapshot without rewriting its contents, ciphertext or hashes", async () => {
    const f = await fixture(),
      id = randomUUID();
    // A historical package predating catalog.sourceType. Its source document no longer exists.
    // Digests are fixed fixture values, not calculated by the production implementation.
    const snapshot = {
      schemaVersion: 1,
      title: "Legacy fixed package",
      sourceBotName: "Former source Bot",
      sourceSpaceName: "Legacy simulation business",
      sourceWorkspaceKind: "trading",
      applicability: { conditions: ["Simulation only"], limitations: ["Historical snapshot only"] },
      items: [
        {
          key: "memory:legacy-memory-document",
          kind: "memory",
          title: "MEMORY.md",
          content: "Legacy memory snapshot",
          description: null,
          files: null,
          sourceId: "legacy-memory-document",
          sourceRevision: "7",
          contentHash: "7835f5753498208adcb716c4f2b4c0456c0daccfa0b9617b8d690716f22cfd0c",
        },
      ],
    };
    const contentHash = "312bb34c4445c2fd47dd635b85800265b08b8d1d339094d98f839cfc27dec100";
    await system(() =>
      db.prisma.experiencePackage.create({
        data: {
          id,
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          sourceBotId: f.from.bot.id,
          requestId: "legacy-request",
          requestHash: "legacy-request-hash",
          lineageId: id,
          version: 1,
          snapshot,
          contentHash,
        },
      }),
    );
    const stored = () =>
      system(
        async () =>
          (
            await db.pool.query(
              'SELECT snapshot::text, "contentHash", "requestHash", version FROM experience_packages WHERE id=$1',
              [id],
            )
          ).rows[0],
      );
    const before = await stored();
    await f.from.rpc.catalog({ sourceBotId: f.from.bot.id });
    const original = await f.to.rpc.get({ packageId: id });
    expect(original.snapshot).toEqual(snapshot);
    expect(original.contentHash).toBe(contentHash);
    expect((await f.to.rpc.packages({})).items).toContainEqual(original);
    const preview = await f.to.rpc.preview({ packageId: id, targetBotId: f.to.bot.id });
    expect(preview.package).toEqual(original);
    const confirmation = {
      packageId: id,
      targetBotId: f.to.bot.id,
      plan: preview.plan,
      previewHash: preview.previewHash,
    };
    const receipt = await f.to.rpc.confirm(confirmation);
    expect(receipt.packageHash).toBe(contentHash);
    expect((await f.to.rpc.importDetail({ importId: receipt.id })).package).toEqual(original);
    expect(await f.to.rpc.confirm(confirmation)).toEqual(receipt);
    expect(await stored()).toEqual(before);
    expect(
      await system(() =>
        db.prisma.memoryDocument.findUnique({ where: { id: receipt.items[0]!.targetId! } }),
      ),
    ).toMatchObject({ content: "Legacy memory snapshot", revision: 1 });
  });

  it("rejects a previously previewed import after source membership revocation without creating or consuming copies", async () => {
    const f = await fixture(),
      { pkg, confirmation } = await f.prepare();
    const member = await system(() =>
      db.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: f.from.actor.spaceId, userId: f.from.actor.userId } },
      }),
    );
    await system(() => db.prisma.spaceMember.delete({ where: { id: member.id } }));
    const forbidden = { code: "FORBIDDEN" };
    await expect(f.from.rpc.catalog({ sourceBotId: f.from.bot.id })).rejects.toMatchObject(
      forbidden,
    );
    await expect(f.create()).rejects.toMatchObject(forbidden);
    expect((await f.to.rpc.packages({})).items).toEqual([]);
    await expect(f.to.rpc.get({ packageId: pkg.id })).rejects.toMatchObject(forbidden);
    await expect(
      f.to.rpc.preview({ packageId: pkg.id, targetBotId: f.to.bot.id }),
    ).rejects.toMatchObject(forbidden);
    await expect(f.to.rpc.confirm(confirmation)).rejects.toMatchObject(forbidden);
    expect((await f.to.rpc.history({})).items).toEqual([]);
    expect(await f.to.rpc.skills({ botId: f.to.bot.id })).toEqual([]);
    await system(async () => {
      expect(await db.prisma.experienceImport.count({ where: { packageId: pkg.id } })).toBe(0);
      expect(await db.prisma.memoryDocument.count({ where: { botId: f.to.bot.id } })).toBe(0);
      expect(
        await db.prisma.memoryRevision.count({ where: { document: { botId: f.to.bot.id } } }),
      ).toBe(0);
      expect(
        await db.prisma.experienceHandoffEvent.count({
          where: { packageId: pkg.id, kind: "imported" },
        }),
      ).toBe(0);
      expect(await db.prisma.experiencePackage.findUnique({ where: { id: pkg.id } })).toMatchObject(
        { snapshot: pkg.snapshot, contentHash: pkg.contentHash },
      );
      await db.prisma.spaceMember.create({ data: member });
    });
    // Re-granting source access allows the original, unchanged confirm request to proceed.
    const receipt = await f.to.rpc.confirm(confirmation);
    expect((await f.to.rpc.history({})).items).toEqual([receipt]);
    expect(receipt.items.map((item) => item.status)).toEqual(["copied", "copied", "pending"]);
  });

  it("does not transfer populated synthetic credentials, algorithm approvals or trading grants", async () => {
    const f = await fixture();
    const secretStore = new EncryptedSecretStore("synthetic-handoff-test-encryption-key");
    const plaintext = "synthetic-handoff-credential-not-a-real-key";
    const credentialName = "synthetic_weather_api";
    await runAsTenant(f.from.actor, () =>
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: f.from.actor,
        plaintext,
        destination: {
          name: credentialName,
          origin: "https://weather.example.test",
          auth: { type: "bearer" },
        },
      }),
    );
    const vaultBefore = await system(() =>
      db.prisma.vaultCredential.findFirstOrThrow({
        where: { spaceId: f.from.actor.spaceId, userId: f.from.actor.userId, name: credentialName },
      }),
    );
    expect(vaultBefore.ciphertext).not.toContain(plaintext);
    const connectionSecret = await secretStore.put("synthetic-connection-token-not-a-real-key", {
      ...f.from.actor,
      operationId: "synthetic-handoff",
      traceId: "synthetic-handoff",
      signal: new AbortController().signal,
    });
    const connection = await system(async () => {
      await db.prisma.secret.create({
        data: {
          id: connectionSecret.id,
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          kind: "synthetic-connection",
          ciphertext: connectionSecret.ciphertext,
        },
      });
      return db.prisma.connection.create({
        data: {
          spaceId: f.from.actor.spaceId,
          userId: f.from.actor.userId,
          connectorId: "synthetic",
          provider: "synthetic",
          displayName: "Synthetic weather",
          status: "connected",
          secretId: connectionSecret.id,
        },
      });
    });
    const expiresAt = "2030-05-01T01:00:00.000Z";
    async function tradingSetup(side: typeof f.from) {
      const api = rootClient(side.actor).trading;
      const desk = await api.createDesk({
        scope: {
          subjectId: "synthetic-retailer",
          subjectKind: "retailer",
          accountId: "synthetic-account",
          assetId: "synthetic-asset",
          region: "CN-SD",
          marketId: "synthetic",
          productId: "energy",
          stage: "day_ahead",
          environment: "simulation",
        },
        botId: side.bot.id,
        algorithmApproverUserId: side.actor.userId,
        tradeApproverUserId: side.actor.userId,
      });
      const analysis = await api.simulate({ scope: desk.scope });
      const intent = await api.prepareIntent({
        deskId: desk.id,
        analysisId: analysis.id,
        expiresAt,
      });
      const version = (await api.desk({ deskId: desk.id })).versions[0]!;
      return { api, desk, intent, version };
    }
    const source = await tradingSetup(f.from),
      target = await tradingSetup(f.to);
    await source.api.approveAlgorithm({
      deskId: source.desk.id,
      versionId: source.version.id,
      expectedArtifactHash: source.version.artifactHash,
    });
    await source.api.approveIntent({
      deskId: source.desk.id,
      intentId: source.intent.id,
      expectedIntentHash: source.intent.intent.intentHash,
    });
    const grant = await source.api.createGrant({
      deskId: source.desk.id,
      versionId: source.version.id,
      botId: f.from.bot.id,
      perTradeLimitCny: "50000",
      cumulativeLimitCny: "100000",
      expiresAt,
    });
    const sourceBefore = await source.api.desk({ deskId: source.desk.id });
    expect(sourceBefore.versions[0]?.status).toBe("approved");
    expect(sourceBefore.grants).toEqual([grant]);
    expect(grant).toMatchObject({ revokedAt: null, botId: f.from.bot.id });
    const targetBefore = await target.api.desk({ deskId: target.desk.id });
    expect(targetBefore.versions[0]?.status).toBe("pending");
    expect(targetBefore.grants).toEqual([]);
    const { pkg, confirmation } = await f.prepare();
    const receipt = await f.to.rpc.confirm(confirmation);
    expect(await target.api.desk({ deskId: target.desk.id })).toEqual(targetBefore);
    expect(await source.api.desk({ deskId: source.desk.id })).toEqual(sourceBefore);
    expect(await runAsTenant(f.to.actor, () => listBotSecrets(db.prisma, f.to.actor))).toEqual([]);
    expect(
      await runAsTenant(f.to.actor, () =>
        revealBotSecret({
          prisma: db.prisma,
          secretStore,
          scope: f.to.actor,
          name: credentialName,
        }),
      ),
    ).toBeNull();
    expect(
      await runAsTenant(f.from.actor, () =>
        revealBotSecret({
          prisma: db.prisma,
          secretStore,
          scope: f.from.actor,
          name: credentialName,
        }),
      ),
    ).toEqual({ value: plaintext });
    const copies = await system(async () => {
      expect(await db.prisma.vaultCredential.findUnique({ where: { id: vaultBefore.id } })).toEqual(
        vaultBefore,
      );
      expect(await db.prisma.connection.findUnique({ where: { id: connection.id } })).toEqual(
        connection,
      );
      expect(
        await db.prisma.secret.findUnique({ where: { id: connectionSecret.id } }),
      ).toMatchObject({ spaceId: f.from.actor.spaceId, ciphertext: connectionSecret.ciphertext });
      const targetScope = { spaceId: f.to.actor.spaceId, userId: f.to.actor.userId };
      expect(await db.prisma.vaultCredential.count({ where: targetScope })).toBe(0);
      expect(await db.prisma.secret.count({ where: targetScope })).toBe(0);
      expect(await db.prisma.botSecret.count({ where: targetScope })).toBe(0);
      expect(await db.prisma.connection.count({ where: targetScope })).toBe(0);
      expect(await db.prisma.mcpServer.count({ where: targetScope })).toBe(0);
      expect(
        await db.prisma.experienceImport.count({
          where: { packageId: pkg.id, targetBotId: f.to.bot.id },
        }),
      ).toBe(1);
      const memories = await db.prisma.memoryDocument.findMany({ where: { botId: f.to.bot.id } });
      expect(memories).toHaveLength(2);
      return memories;
    });
    const skills = await f.to.rpc.skills({ botId: f.to.bot.id });
    expect(skills).toHaveLength(1);
    const exported = JSON.stringify({
      pkg,
      receipt,
      copies,
      skills,
      detail: await f.to.rpc.importDetail({ importId: receipt.id }),
    });
    for (const forbidden of [
      plaintext,
      "synthetic-connection-token-not-a-real-key",
      vaultBefore.id,
      vaultBefore.ciphertext,
      connectionSecret.id,
      connectionSecret.ciphertext,
      connection.id,
      grant.id,
      source.version.id,
    ]) {
      expect(exported).not.toContain(forbidden);
    }
    const request = {
      deskId: target.desk.id,
      intentId: target.intent.id,
      clientRequestId: "synthetic-unapproved-execution",
      expectedIntentHash: target.intent.intent.intentHash,
    };
    await expect(target.api.executeSimulation(request)).rejects.toMatchObject({
      data: { reason: "ALGORITHM_NOT_APPROVED" },
    });
    // A separate, explicit target algorithm approval still grants no trade permission.
    await target.api.approveAlgorithm({
      deskId: target.desk.id,
      versionId: target.version.id,
      expectedArtifactHash: target.version.artifactHash,
    });
    await expect(target.api.executeSimulation(request)).rejects.toMatchObject({
      data: { reason: "TRADE_NOT_APPROVED" },
    });
    await expect(
      target.api.executeSimulation({ ...request, grantId: grant.id }),
    ).rejects.toMatchObject({ data: { reason: "GRANT_MISMATCH" } });
    expect((await target.api.desk({ deskId: target.desk.id })).executions).toEqual([]);
  });

  it.each(["sequential", "concurrent"] as const)(
    "keeps byte-identical confirm requests idempotent under %s submission, with one receipt and one set of copies",
    async (mode) => {
      const f = await fixture(),
        { pkg, confirmation } = await f.prepare();
      const body = JSON.stringify(confirmation);
      // Reuse the entire original request, including previewHash; never re-preview between attempts.
      const send = () => f.to.rpc.confirm(JSON.parse(body));
      const responses =
        mode === "concurrent"
          ? await Promise.all([send(), send(), send(), send()])
          : [await send(), await send(), await send(), await send()];
      const receipt = responses[0]!;
      for (const response of responses) expect(response).toEqual(receipt);
      expect(await send()).toEqual(receipt);
      expect((await f.to.rpc.history({ botId: f.to.bot.id })).items).toEqual([receipt]);
      expect((await f.from.rpc.history({ botId: f.from.bot.id })).items).toEqual([receipt]);
      const skillCopies = await f.to.rpc.skills({ botId: f.to.bot.id });
      expect(skillCopies).toHaveLength(1);
      expect(skillCopies[0]).toMatchObject({
        id: receipt.items.find((item) => item.kind === "skill")!.targetId,
        importId: receipt.id,
        revision: 1,
        enabledAt: null,
      });
      await system(async () => {
        expect(
          await db.prisma.experienceImport.count({
            where: { packageId: pkg.id, targetBotId: f.to.bot.id },
          }),
        ).toBe(1);
        expect(await db.prisma.experienceSkill.count({ where: { botId: f.to.bot.id } })).toBe(1);
        const memories = await db.prisma.memoryDocument.findMany({
          where: { botId: f.to.bot.id },
          include: { revisions: true },
        });
        expect(memories).toHaveLength(2);
        expect(memories.map((doc) => doc.id).sort()).toEqual(
          receipt.items
            .filter((item) => item.kind !== "skill")
            .map((item) => item.targetId)
            .sort(),
        );
        expect(memories.map((doc) => doc.content).sort()).toEqual(
          [f.input.summaries[0]!.content, f.memory.content].sort(),
        );
        for (const doc of memories) {
          expect(doc.revision).toBe(1);
          expect(doc.revisions).toHaveLength(1);
        }
        expect(
          await db.prisma.memoryRevision.count({ where: { document: { botId: f.to.bot.id } } }),
        ).toBe(2);
        expect(
          await db.prisma.experienceHandoffEvent.count({
            where: { packageId: pkg.id, importId: receipt.id, kind: "imported" },
          }),
        ).toBe(1);
        expect(await db.prisma.task.count({ where: { botId: f.to.bot.id } })).toBe(0);
        expect(await db.prisma.run.count({ where: { botId: f.to.bot.id } })).toBe(0);
      });
    },
  );
});

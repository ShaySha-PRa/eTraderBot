import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import {
  businessOverview,
  createDb,
  createRepos,
  createTradingBotService,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTicketChangeNotifier } from "../../../packages/adapters/src/ticket-changes.js";
import {
  commentTicket,
  createTicket,
  updateTicket,
} from "../../../packages/adapters/src/ticket-tools.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("business supervisor (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const actor: Actor = {
    userId: randomUUID(),
    spaceId: randomUUID(),
    email: `${randomUUID()}@example.test`,
    isDeploymentOwner: false,
  };
  const other = { ...actor, spaceId: randomUUID() };
  const org = randomUUID();
  const jobs: unknown[] = [];
  const system = <T>(f: () => Promise<T>) => runAsSystem("synthetic supervisor fixture", f);
  const client = (who = actor) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        env: {},
        ticketChanges: notify(),
        auth: { hasRecentIdentityConfirmation: async () => true },
      } as unknown as RouterDeps),
      { context: { actor: who } },
    );
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
  const deps = () => ({ prisma: db.prisma, onTicketChange: notify() });
  const spec = {
    name: "Synthetic business",
    scope: {
      subjectId: "synthetic",
      subjectKind: "retailer" as const,
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
  beforeAll(() =>
    system(async () => {
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic owner" },
      });
      await db.prisma.organization.create({
        data: { id: org, name: "Synthetic", slug: org, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId: actor.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      for (const scope of [actor, other]) {
        await db.prisma.space.create({
          data: {
            id: scope.spaceId,
            organizationId: org,
            name: "Synthetic",
            kind: scope === actor ? "trading" : "general",
            createdByUserId: actor.userId,
          },
        });
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId: org,
            spaceId: scope.spaceId,
            userId: actor.userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
      }
    }),
  );
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  it("provisions exactly one supervisor with separate identity and no trading binding", async () => {
    const service = createTradingWorkspaceService(db.prisma);
    await runAsTenant(actor, () => service.create(actor, spec));
    await Promise.all([
      runAsTenant(actor, () => service.create(actor, spec)),
      runAsTenant(actor, () => service.list(actor)),
    ]);
    const rows = await system(() =>
      db.prisma.bot.findMany({
        where: { spaceId: actor.spaceId, businessSupervisor: true },
        include: { thread: true, tradingBindings: true },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: actor.userId,
      tradingRole: null,
      crossSpaceCommunication: false,
      tradingBindings: [],
    });
    expect(rows[0]?.thread).not.toBeNull();
    const id = rows[0]!.id;
    await expect(client().bots.duplicate({ botId: id })).rejects.toThrow("cannot be copied");
    await expect(client().bots.archive({ botId: id })).rejects.toThrow("stays with");
    await expect(
      system(() => db.prisma.bot.update({ where: { id }, data: { tradingRole: "spot" } })),
    ).rejects.toThrow();
    await expect(
      system(() => db.prisma.bot.update({ where: { id }, data: { spaceId: other.spaceId } })),
    ).rejects.toThrow();
    await expect(
      runAsTenant(actor, () =>
        createTradingBotService(db.prisma).call({ ...actor, botId: id }, { operation: "scopes" }),
      ),
    ).rejects.toThrow("cannot use trading operations");
  });
  it("assigns real queued work, preserves results and computes progress from all persisted tickets", async () => {
    const supervisor = await client().businessSupervisor.overview({});
    const bot = await runAsTenant(actor, () =>
      createRepos(db.prisma).createBot(actor, {
        name: "Synthetic spot",
        tradingRole: "spot",
        instructions: "",
        description: "",
        notifyOnFinish: true,
      }),
    );
    const foreign = await runAsTenant(other, () =>
      createRepos(db.prisma).createBot(other, {
        name: "Synthetic general",
        instructions: "",
        description: "",
        notifyOnFinish: true,
      }),
    );
    const result = await runAsTenant(actor, () =>
      createTicket(deps(), {
        ...actor,
        botId: supervisor.supervisorId,
        ownerBotId: bot.id,
        title: "Synthetic exposure review",
      }),
    );
    expect(result).toHaveProperty("ticket");
    if (!result.ticket) throw new Error("No ticket");
    const ticket = result.ticket;
    expect(jobs).toHaveLength(1);
    expect(
      await system(() =>
        db.prisma.run.count({
          where: { spaceId: actor.spaceId, botId: bot.id, trigger: "tickets", status: "queued" },
        }),
      ),
    ).toBe(1);
    expect(await client().tickets.list({})).toMatchObject({ tickets: [{ id: ticket.id }] });
    await runAsTenant(actor, () =>
      commentTicket(deps(), {
        ...actor,
        botId: bot.id,
        id: ticket.id,
        body: "Synthetic evidence: reviewed; human approval remains pending.",
      }),
    );
    await runAsTenant(actor, () =>
      updateTicket(deps(), { ...actor, botId: bot.id, id: ticket.id, status: "done" }),
    );
    const state = await runAsTenant(actor, () =>
      businessOverview(db.prisma, { ...actor, botId: supervisor.supervisorId }),
    );
    expect(state).toMatchObject({
      total: 1,
      completed: 1,
      completionPercent: 100,
      counts: { done: 1 },
    });
    expect(state.recentTasks[0]?.latestComment).toContain("human approval remains pending");
    await expect(client(other).businessSupervisor.overview({})).rejects.toThrow();
    await expect(
      runAsTenant(actor, () => businessOverview(db.prisma, { ...actor, botId: bot.id })),
    ).rejects.toThrow("Only the business supervisor");
    expect(
      await runAsTenant(actor, () =>
        createTicket(deps(), {
          ...actor,
          botId: supervisor.supervisorId,
          ownerBotId: foreign.id,
          title: "Denied",
        }),
      ),
    ).toEqual({ error: "Unknown bot." });
    await system(() =>
      db.prisma.ticket.createMany({
        data: Array.from({ length: 35 }, (_, i) => ({
          boardId: ticket.boardId,
          spaceId: actor.spaceId,
          number: 100 + i,
          title: "Synthetic blocker",
          status: "blocked",
          assigneeBotId: bot.id,
          createdByUserId: actor.userId,
        })),
      }),
    );
    const all = await client().businessSupervisor.overview({});
    expect(all).toMatchObject({
      total: 36,
      completed: 1,
      counts: { blocked: 35 },
      completionPercent: 3,
    });
    expect(all.recentTasks).toHaveLength(30);
    await runAsTenant(actor, () =>
      updateTicket(deps(), { ...actor, botId: bot.id, id: ticket.id, status: "closed" }),
    );
    expect(await client().businessSupervisor.overview({})).toMatchObject({
      completed: 0,
      counts: { closed: 1 },
    });
  });
});

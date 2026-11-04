import type { BackgroundJob, TradingBotGateway } from "@rakazo/adapter-kit";
import { routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import { TradingBotCommandSchema } from "@rakazo/contracts";
import { tradingAssert } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { createTradingAnalysisService } from "./trading.js";
import { checkTradingBot } from "./trading-bot-access.js";
import { createTradingControlService } from "./trading-control.js";
import { createTradingLearningService } from "./trading-learning.js";
import { createTradingWeatherService } from "./trading-weather.js";
import { requireIsolatedBot } from "./workspace-isolation.js";

export function createTradingBotService(
  prisma: PrismaClient,
  clock: () => Date = () => new Date(),
  jobs?: { enqueue(job: BackgroundJob): Promise<unknown> },
): TradingBotGateway {
  const control = createTradingControlService(prisma, clock);
  const analysis = createTradingAnalysisService(prisma, clock);
  const learning = createTradingLearningService(prisma, clock);
  return {
    async isLearningRun(identity) {
      if (!identity.runId) return false;
      const run = await prisma.run.findFirst({
        where: {
          id: identity.runId,
          botId: identity.botId,
          userId: identity.userId,
          spaceId: identity.spaceId,
        },
      });
      return Boolean(
        run?.routineId &&
          (await prisma.tradingLearningPlan.findUnique({ where: { routineId: run.routineId } })),
      );
    },
    async available(identity) {
      return Boolean(
        await prisma.tradingBotBinding.findFirst({
          where: {
            botId: identity.botId,
            bot: {
              spaceId: identity.spaceId,
              userId: identity.userId,
              archivedAt: null,
              tradingRole: { not: null },
              space: { kind: "trading", isolationPending: false },
            },
            desk: { spaceId: identity.spaceId, ownerUserId: identity.userId },
          },
        }),
      );
    },
    async call(identity, raw) {
      const persisted = await requireIsolatedBot(prisma, identity);
      tradingAssert(
        persisted.tradingRole,
        "FORBIDDEN",
        "General Bots cannot use trading operations",
      );
      const parsed = TradingBotCommandSchema.safeParse(raw);
      tradingAssert(parsed.success, "INVALID_INPUT", "Invalid trading operation or arguments");
      const input = parsed.data;
      let learningDeskId: string | undefined;
      // A learning timer is never a trading execution trigger, even if the Bot holds a grant.
      if (identity.runId) {
        const run = await prisma.run.findFirst({
          where: {
            id: identity.runId,
            userId: identity.userId,
            spaceId: identity.spaceId,
            botId: identity.botId,
          },
        });
        tradingAssert(run, "FORBIDDEN", "Persisted Bot run not found");
        const plan = run.routineId
          ? await prisma.tradingLearningPlan.findUnique({ where: { routineId: run.routineId } })
          : null;
        if (plan) {
          learningDeskId = plan.deskId;
          tradingAssert(
            input.operation === "scopes" ||
              ((input.operation === "learning_open" || input.operation === "learning_propose") &&
                input.deskId === plan.deskId),
            "FORBIDDEN",
            "Learning runs may only read their scope and submit learning reports",
          );
        }
      }
      if (input.operation === "scopes") {
        const rows = await prisma.tradingBotBinding.findMany({
          where: {
            ...(learningDeskId ? { deskId: learningDeskId } : {}),
            botId: identity.botId,
            bot: {
              spaceId: identity.spaceId,
              userId: identity.userId,
              archivedAt: null,
              tradingRole: { not: null },
              space: { kind: "trading", isolationPending: false },
            },
            desk: { spaceId: identity.spaceId, ownerUserId: identity.userId },
          },
          select: { deskId: true, role: true, desk: { select: { scope: true } } },
          take: 100,
        });
        return rows.map((row) => ({ deskId: row.deskId, role: row.role, scope: row.desk.scope }));
      }
      const { scope } = await checkTradingBot(
        prisma,
        identity,
        input.deskId,
        input.operation === "analyze" ||
          input.operation === "prepare" ||
          input.operation === "execute" ||
          input.operation === "cancel",
      );
      const user = await prisma.user.findFirst({
        where: { id: identity.userId },
        select: { email: true },
      });
      tradingAssert(user, "FORBIDDEN", "Run owner unavailable");
      const actor = { ...identity, email: user.email, isDeploymentOwner: false };
      if (input.operation === "learning_capture_message")
        return learning.captureMessage(actor, {
          deskId: input.deskId,
          botId: identity.botId,
          messageId: input.messageId,
        });
      if (input.operation === "learning_open") return learning.open(actor, identity, input.deskId);
      if (input.operation === "learning_propose")
        return learning.propose(actor, identity, input.deskId, input.proposal);
      if (input.operation === "learning_schedule") {
        const updated = await learning.configure(actor, { ...input, botId: identity.botId });
        if (updated.nextRunAt)
          await jobs?.enqueue(routineWakeupJob(updated.routineId, new Date(updated.nextRunAt)));
        return updated;
      }
      if (input.operation === "learning_start") {
        const result = await learning.start(actor, {
          deskId: input.deskId,
          botId: identity.botId,
          clientRequestId: input.clientRequestId,
        });
        await jobs?.enqueue(runContinueJob(result.runId));
        return result;
      }
      if (input.operation === "weather") {
        const link = await prisma.tradingWorkspaceDesk.findUnique({
          where: { deskId: input.deskId },
        });
        tradingAssert(link, "NOT_FOUND", "Business scope not found");
        return createTradingWeatherService(prisma, clock).forecasts(actor, {
          workspaceId: link.workspaceId,
          siteId: input.siteId,
          limit: 1,
        });
      }
      if (input.operation === "context") {
        const state = await control.desk(actor, input);
        return {
          ...state,
          versions: state.versions.map(({ artifact: _artifact, ...version }) => version),
        };
      }
      if (input.operation === "analyze")
        return analysis.simulate(actor, { scope, parameters: { margin: input.margin } });
      if (input.operation === "prepare") {
        const stored = await analysis.get(actor, input.analysisId);
        const expiresAt = new Date(
          Math.min(
            clock().getTime() + 900_000,
            Date.parse(stored.snapshot.source.validUntil),
            Date.parse(stored.snapshot.rules.source.validUntil),
          ),
        ).toISOString();
        return control.prepareIntent(
          actor,
          { deskId: input.deskId, analysisId: input.analysisId, expiresAt },
          identity.botId,
        );
      }
      if (input.operation === "reconcile") {
        const { operation: _operation, ...request } = input;
        return control.reconcileExecution(actor, request, identity.botId);
      }
      if (input.operation === "cancel") {
        const { operation: _operation, ...request } = input;
        return control.cancelSimulation(actor, request, identity.botId);
      }
      const { operation: _operation, ...request } = input;
      return control.executeSimulation(actor, request, identity.botId);
    },
  };
}

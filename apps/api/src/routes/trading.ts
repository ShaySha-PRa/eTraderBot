import { ORPCError } from "@orpc/server";
import { routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import { pullWeatherForecast } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import {
  createTradingLearningService,
  createTradingWeatherService,
  createTradingWorkspaceService,
  InvalidSpaceNameError,
  IsolationError,
  runAsSystem,
  SpaceLimitError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import { createTradingAnalysisService } from "../trading.js";
import { createTradingControlService } from "../trading-control.js";
import type { RouterContext } from "./context.js";

async function tradingResult<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    if (error instanceof TradingError) {
      throw new ORPCError(
        error.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "FORBIDDEN"
            ? "FORBIDDEN"
            : "BAD_REQUEST",
        {
          message: error.message,
          data: { reason: error.code },
        },
      );
    }
    throw error;
  }
}
export function tradingRoutes(ctx: RouterContext) {
  const service = createTradingAnalysisService(ctx.deps.prisma, ctx.deps.tradingClock);
  const control = createTradingControlService(ctx.deps.prisma, ctx.deps.tradingClock);
  const learning = createTradingLearningService(ctx.deps.prisma, ctx.deps.tradingClock);
  const weather = createTradingWeatherService(ctx.deps.prisma, ctx.deps.tradingClock);
  const workspaces = createTradingWorkspaceService(ctx.deps.prisma, ctx.deps.tradingClock);
  async function wake(actor: Actor, deskId: string, botId: string) {
    const routine = await learning.schedule(actor, deskId, botId);
    if (routine.active && routine.nextRunAt)
      await ctx.deps.jobs
        ?.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))
        .catch((error) => getLogger().error("trading learning schedule enqueue", error));
  }
  async function human<T>(
    context: { actor: Actor | null; sessionId?: string },
    action: () => Promise<T>,
  ) {
    await requireIdentityConfirmation(ctx.deps.auth, context);
    return tradingResult(action);
  }
  return {
    trading: {
      weatherForecasts: ctx.authed.trading.weatherForecasts.handler(({ context, input }) =>
        tradingResult(() => weather.forecasts(context.actor, input)),
      ),
      rotateWeatherPushToken: ctx.authed.trading.rotateWeatherPushToken.handler(
        ({ context, input }) => human(context, () => weather.rotateToken(context.actor, input)),
      ),
      revokeWeatherPushToken: ctx.authed.trading.revokeWeatherPushToken.handler(
        ({ context, input }) => human(context, () => weather.revokeToken(context.actor, input)),
      ),
      pullWeather: ctx.authed.trading.pullWeather.handler(({ context, input }) =>
        tradingResult(async () => {
          const source = await weather.pullSource(context.actor, input);
          const credential = source.secret
            ? await ctx.deps.secrets.load(source.secret.ciphertext, {
                recordId: source.secret.id,
                signal: context.signal,
              })
            : undefined;
          const forecast = await pullWeatherForecast(
            source.config,
            credential,
            { allowPrivateEndpoint: ctx.deps.env.mcpAllowPrivateEndpoint },
            context.signal,
          );
          return weather.acceptPull(context.actor, input, source.revision, forecast);
        }),
      ),
      workspaces: ctx.authed.trading.workspaces.handler(({ context }) =>
        tradingResult(() => workspaces.list(context.actor)),
      ),
      createWorkspace: ctx.authed.trading.createWorkspace.handler(({ context, input }) =>
        human(context, () => workspaces.create(context.actor, input)),
      ),
      createBusinessScope: ctx.authed.trading.createBusinessScope.handler(({ context, input }) =>
        human(context, () =>
          runAsSystem("create business scope for its member", () =>
            workspaces.createBusinessScope(context.actor, input),
          ),
        ),
      ),
      connectWorkspaceBot: ctx.authed.trading.connectWorkspaceBot.handler(({ context, input }) =>
        human(context, () => workspaces.connect(context.actor, input)),
      ),
      interfaces: ctx.authed.trading.interfaces.handler(({ context, input }) =>
        tradingResult(() => workspaces.interfaces(context.actor, input.workspaceId)),
      ),
      saveInterface: ctx.authed.trading.saveInterface.handler(({ context, input }) =>
        human(context, async () => {
          await workspaces.canConfigure(context.actor, input.workspaceId);
          const stored =
            input.config.transport === "http" && input.config.auth !== "none" && input.secret
              ? await ctx.deps.secrets.put(input.secret, {
                  operationId: "trading.interface.save",
                  traceId: "trading.interface.save",
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  signal: context.signal ?? new AbortController().signal,
                })
              : undefined;
          try {
            return await workspaces.saveInterface(context.actor, input, stored);
          } catch (error) {
            if (stored) await ctx.deps.secrets.delete(stored.ref, stored.id).catch(() => undefined);
            throw error;
          }
        }),
      ),
      removeInterface: ctx.authed.trading.removeInterface.handler(({ context, input }) =>
        human(context, () => workspaces.removeInterface(context.actor, input)),
      ),
      learningState: ctx.authed.trading.learningState.handler(({ context, input }) =>
        tradingResult(() => learning.state(context.actor, input)),
      ),
      shareLearningExperience: ctx.authed.trading.shareLearningExperience.handler(
        ({ context, input }) =>
          human(context, () => learning.shareExperience(context.actor, input)),
      ),
      configureLearning: ctx.authed.trading.configureLearning.handler(({ context, input }) =>
        tradingResult(async () => {
          const result = await learning.configure(context.actor, input);
          await wake(context.actor, input.deskId, input.botId);
          return result;
        }),
      ),
      addLearningSource: ctx.authed.trading.addLearningSource.handler(({ context, input }) =>
        tradingResult(() => learning.addSource(context.actor, input)),
      ),
      captureLearningMessage: ctx.authed.trading.captureLearningMessage.handler(
        ({ context, input }) => tradingResult(() => learning.captureMessage(context.actor, input)),
      ),
      startLearning: ctx.authed.trading.startLearning.handler(({ context, input }) =>
        tradingResult(async () => {
          const result = await learning.start(context.actor, input);
          await ctx.deps.jobs
            ?.enqueue(runContinueJob(result.runId))
            .catch((error) => getLogger().error("trading learning run enqueue", error));
          return result;
        }),
      ),
      participants: ctx.authed.trading.participants.handler(({ context }) =>
        tradingResult(() => control.participants(context.actor)),
      ),
      bindBot: ctx.authed.trading.bindBot.handler(({ context, input }) =>
        human(context, async () => {
          const binding = await control.bindBot(context.actor, input);
          await wake(context.actor, input.deskId, input.botId);
          return binding;
        }),
      ),
      unbindBot: ctx.authed.trading.unbindBot.handler(({ context, input }) =>
        human(context, () => control.unbindBot(context.actor, input)),
      ),
      createDesk: ctx.authed.trading.createDesk.handler(({ context, input }) =>
        human(context, () => control.createDesk(context.actor, input)),
      ),
      desks: ctx.authed.trading.desks.handler(({ context, input }) =>
        tradingResult(() => control.desks(context.actor, input)),
      ),
      desk: ctx.authed.trading.desk.handler(({ context, input }) =>
        tradingResult(() => control.desk(context.actor, input)),
      ),
      prepareIntent: ctx.authed.trading.prepareIntent.handler(({ context, input }) =>
        tradingResult(() => control.prepareIntent(context.actor, input)),
      ),
      approveAlgorithm: ctx.authed.trading.approveAlgorithm.handler(({ context, input }) =>
        human(context, () => control.approveAlgorithm(context.actor, input)),
      ),
      retireAlgorithm: ctx.authed.trading.retireAlgorithm.handler(({ context, input }) =>
        human(context, () => control.retireAlgorithm(context.actor, input)),
      ),
      approveIntent: ctx.authed.trading.approveIntent.handler(({ context, input }) =>
        human(context, () => control.approveIntent(context.actor, input)),
      ),
      createGrant: ctx.authed.trading.createGrant.handler(({ context, input }) =>
        human(context, () => control.createGrant(context.actor, input)),
      ),
      revokeGrant: ctx.authed.trading.revokeGrant.handler(({ context, input }) =>
        human(context, () => control.revokeGrant(context.actor, input)),
      ),
      executeSimulation: ctx.authed.trading.executeSimulation.handler(({ context, input }) =>
        tradingResult(() => control.executeSimulation(context.actor, input)),
      ),
      configureSimulation: ctx.authed.trading.configureSimulation.handler(({ context, input }) =>
        human(context, () => control.configureSimulation(context.actor, input)),
      ),
      reconcileExecution: ctx.authed.trading.reconcileExecution.handler(({ context, input }) =>
        tradingResult(() => control.reconcileExecution(context.actor, input)),
      ),
      cancelSimulation: ctx.authed.trading.cancelSimulation.handler(({ context, input }) =>
        human(context, () => control.cancelSimulation(context.actor, input)),
      ),
      executionByRequest: ctx.authed.trading.executionByRequest.handler(({ context, input }) =>
        tradingResult(() => control.executionByRequest(context.actor, input)),
      ),
      simulate: ctx.authed.trading.simulate.handler(({ context, input }) =>
        tradingResult(() => service.simulate(context.actor, input)),
      ),
      get: ctx.authed.trading.get.handler(({ context, input }) =>
        tradingResult(() => service.get(context.actor, input.id)),
      ),
      replay: ctx.authed.trading.replay.handler(({ context, input }) =>
        tradingResult(() => service.replay(context.actor, input.id)),
      ),
      history: ctx.authed.trading.history.handler(({ context, input }) =>
        tradingResult(() => service.history(context.actor, input.limit)),
      ),
    },
  };
}

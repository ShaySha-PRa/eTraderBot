import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Actor, RpcInput, TradingWeatherForecast } from "@rakazo/contracts";
import {
  TradingInterfaceConfigSchema,
  TradingWeatherForecastSchema,
  TradingWeatherRecordSchema,
  WEATHER_PUSH_PATH,
} from "@rakazo/contracts";
import { isWeatherFresh, tradingAssert } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { tradingCanonical } from "./trading-engine.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Tx = Prisma.TransactionClient;
type Source = Prisma.TradingWorkspaceInterfaceGetPayload<object>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function workspace(db: Tx | PrismaClient, actor: Actor, id: string, owner = false) {
  const row = await db.tradingWorkspace.findFirst({
    where: {
      id,
      spaceId: actor.spaceId,
      ...(owner
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
async function source(db: Tx | PrismaClient, workspaceId: string, interfaceId: string) {
  const row = await db.tradingWorkspaceInterface.findFirst({
    where: { id: interfaceId, workspaceId },
  });
  tradingAssert(row?.purpose === "weather_forecast", "NOT_FOUND", "Weather interface not found");
  return row;
}
function acceptsPush(row: Source) {
  return (
    row.purpose === "weather_forecast" &&
    TradingInterfaceConfigSchema.parse(row.config).transport !== "mcp"
  );
}
function validToken(token: string, hash?: string) {
  return Boolean(
    hash && token.length <= 256 && timingSafeEqual(Buffer.from(digest(token)), Buffer.from(hash)),
  );
}
export function createTradingWeatherService(prisma: PrismaClient, clock = () => new Date()) {
  async function change<T>(actor: Actor, workspaceId: string, action: (tx: Tx) => Promise<T>) {
    return withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        await workspace(tx, actor, workspaceId, true);
        return action(tx);
      }),
    );
  }
  async function store(tx: Tx, row: Source, raw: unknown, transport: "pull" | "push") {
    const parsed = TradingWeatherForecastSchema.safeParse(raw);
    tradingAssert(
      parsed.success,
      "INVALID_INPUT",
      "Invalid weather forecast; check the forecast schema and units",
    );
    const forecast = parsed.data;
    const contentHash = digest(tradingCanonical(forecast));
    const existing = await tx.tradingWeatherForecast.findUnique({
      where: { interfaceId_batchId: { interfaceId: row.id, batchId: forecast.batchId } },
    });
    if (existing) {
      tradingAssert(
        existing.contentHash === contentHash,
        "IDEMPOTENCY_CONFLICT",
        "This batch ID already contains a different forecast",
      );
      return {
        id: existing.id,
        batchId: existing.batchId,
        receivedAt: existing.receivedAt.toISOString(),
        duplicate: true,
      };
    }
    const now = clock();
    tradingAssert(
      isWeatherFresh(forecast, now),
      "STALE_DATA",
      "Forecast is expired or issued in the future",
    );
    const saved = await tx.tradingWeatherForecast.create({
      data: {
        id: randomUUID(),
        workspaceId: row.workspaceId,
        interfaceId: row.id,
        interfaceName: row.name,
        batchId: forecast.batchId,
        siteId: forecast.location.siteId,
        issuedAt: new Date(forecast.issuedAt),
        receivedAt: now,
        transport,
        contentHash,
        forecast: forecast as Prisma.InputJsonValue,
      },
    });
    return {
      id: saved.id,
      batchId: saved.batchId,
      receivedAt: saved.receivedAt.toISOString(),
      duplicate: false,
    };
  }
  async function authenticate(db: Tx | PrismaClient, interfaceId: string, token: string) {
    const row = await db.tradingWorkspaceInterface.findUnique({
      where: { id: interfaceId },
      include: { weatherIngress: true },
    });
    tradingAssert(
      row && acceptsPush(row) && validToken(token, row.weatherIngress?.tokenHash),
      "FORBIDDEN",
      "Invalid weather push credential",
    );
    return row;
  }
  return {
    async forecasts(actor: Actor, input: RpcInput<"trading/weatherForecasts">) {
      await workspace(prisma, actor, input.workspaceId);
      const rows = await prisma.tradingWeatherForecast.findMany({
        where: {
          workspaceId: input.workspaceId,
          ...(input.interfaceId ? { interfaceId: input.interfaceId } : {}),
          ...(input.siteId ? { siteId: input.siteId } : {}),
        },
        orderBy: [{ issuedAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }],
        take: input.limit,
      });
      return rows.map((row) => {
        const forecast = TradingWeatherForecastSchema.parse(row.forecast);
        return TradingWeatherRecordSchema.parse({
          id: row.id,
          workspaceId: row.workspaceId,
          interfaceId: row.interfaceId,
          interfaceName: row.interfaceName,
          receivedAt: row.receivedAt.toISOString(),
          transport: row.transport,
          fresh: isWeatherFresh(forecast, clock()),
          forecast,
        });
      });
    },
    async pullSource(actor: Actor, input: RpcInput<"trading/pullWeather">) {
      await workspace(prisma, actor, input.workspaceId, true);
      const row = await source(prisma, input.workspaceId, input.interfaceId);
      const config = TradingInterfaceConfigSchema.parse(row.config);
      tradingAssert(
        config.transport === "http",
        "INVALID_INPUT",
        "Pull requires an HTTP weather interface",
      );
      const secret = row.secretId
        ? await prisma.secret.findFirst({
            where: { id: row.secretId, userId: actor.userId, spaceId: actor.spaceId },
          })
        : null;
      tradingAssert(
        config.auth === "none" || secret,
        "INVALID_INPUT",
        "Weather credential unavailable",
      );
      return { config, revision: row.revision, secret };
    },
    acceptPull(
      actor: Actor,
      input: RpcInput<"trading/pullWeather">,
      revision: number,
      forecast: TradingWeatherForecast,
    ) {
      return change(actor, input.workspaceId, async (tx) => {
        const row = await source(tx, input.workspaceId, input.interfaceId);
        tradingAssert(
          row.revision === revision,
          "IDEMPOTENCY_CONFLICT",
          "Interface changed during pull; retry with its current configuration",
        );
        return store(tx, row, forecast, "pull");
      });
    },
    rotateToken(actor: Actor, input: RpcInput<"trading/rotateWeatherPushToken">) {
      return change(actor, input.workspaceId, async (tx) => {
        const row = await source(tx, input.workspaceId, input.interfaceId);
        tradingAssert(
          acceptsPush(row),
          "INVALID_INPUT",
          "Push requires an HTTP or push weather interface",
        );
        const token = randomBytes(32).toString("base64url");
        await tx.tradingWeatherIngress.upsert({
          where: { interfaceId: row.id },
          create: { interfaceId: row.id, tokenHash: digest(token) },
          update: { tokenHash: digest(token) },
        });
        return {
          token,
          path: WEATHER_PUSH_PATH.replace(":interfaceId", encodeURIComponent(row.id)),
        };
      });
    },
    revokeToken(actor: Actor, input: RpcInput<"trading/revokeWeatherPushToken">) {
      return change(actor, input.workspaceId, async (tx) => {
        await source(tx, input.workspaceId, input.interfaceId);
        const result = await tx.tradingWeatherIngress.deleteMany({
          where: { interfaceId: input.interfaceId },
        });
        return { revoked: result.count > 0 };
      });
    },
    /** Public ingestion has no session. The scoped credential is its only authority. */
    receivePush(interfaceId: string, token: string, read: () => Promise<unknown>) {
      return runAsSystem("authenticate a business-scoped weather publisher", async () => {
        const authenticated = await authenticate(prisma, interfaceId, token);
        const payload = await read();
        return withTransactionRetry(() =>
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM trading_workspaces WHERE id = ${authenticated.workspaceId} FOR UPDATE`;
            const row = await authenticate(tx, interfaceId, token);
            return store(tx, row, payload, "push");
          }),
        );
      });
    },
  };
}

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRouterClient } from "@orpc/server";
import type { Actor, TradingInterface } from "@rakazo/contracts";
import { WEATHER_MAX_BYTES, WEATHER_PUSH_PATH } from "@rakazo/contracts";
import { createSyntheticWeatherForecast } from "@rakazo/core";
import {
  createDb,
  createTradingBotService,
  createTradingWeatherService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { mountTradingWeatherHttpRoutes } from "./trading-weather-http.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("business weather ingestion (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let now = new Date("2026-11-04T01:10:00Z");
  const organizationId = randomUUID();
  const actor: Actor = {
    userId: randomUUID(),
    spaceId: randomUUID(),
    email: `${randomUUID()}@example.test`,
    isDeploymentOwner: false,
  };
  const secrets = new EncryptedSecretStore("synthetic-weather-encryption-key");
  const client = (who = actor, confirmed = true, allowPrivate = true) =>
    createRouterClient(
      createRouter({
        prisma: db.prisma,
        secrets,
        env: { mcpAllowPrivateEndpoint: allowPrivate },
        tradingClock: () => now,
        auth: { hasRecentIdentityConfirmation: async () => confirmed },
      } as unknown as RouterDeps),
      { context: { actor: who, sessionId: "synthetic-session" } },
    );
  const service = () => createTradingWeatherService(db.prisma, () => now);
  const forecast = () => createSyntheticWeatherForecast(now);
  const inputFor = (entry: TradingInterface) => ({
    workspaceId: entry.workspaceId,
    interfaceId: entry.id,
  });
  const push = async (entry: TradingInterface, token: string, data: unknown = forecast()) => {
    const app = new Hono();
    mountTradingWeatherHttpRoutes(app, { prisma: db.prisma, clock: () => now });
    return app.request(WEATHER_PUSH_PATH.replace(":interfaceId", entry.id), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  };
  async function setup(
    config: TradingInterface["config"] = { transport: "push" },
    secret?: string,
  ) {
    const api = client();
    const workspace = await api.trading.createWorkspace({
      name: "Synthetic weather business",
      scope: {
        subjectId: "synthetic",
        subjectKind: "generator",
        accountId: "synthetic",
        region: "CN-SH",
        marketId: "synthetic",
        productId: "energy",
        environment: "simulation",
      },
      algorithmApproverUserId: actor.userId,
      tradeApproverUserId: actor.userId,
    });
    const entry = await api.trading.saveInterface({
      workspaceId: workspace.id,
      id: randomUUID(),
      name: "Synthetic weather source",
      purpose: "weather_forecast",
      config,
      secret,
      expectedRevision: 0,
    });
    return { api, workspace, entry, input: inputFor(entry) };
  }
  beforeAll(() =>
    runAsSystem("weather fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      await db.prisma.user.create({
        data: { id: actor.userId, email: actor.email, name: "Synthetic weather owner" },
      });
      await db.prisma.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Synthetic weather",
          createdAt: now,
        },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: actor.userId,
          role: "member",
          createdAt: now,
        },
      });
    }),
  );
  beforeEach(() =>
    runAsSystem("isolated weather fixture", async () => {
      now = new Date("2026-11-04T01:10:00Z");
      actor.spaceId = randomUUID();
      await db.prisma.space.create({
        data: {
          kind: "trading",
          id: actor.spaceId,
          organizationId,
          name: "Synthetic scope",
          createdByUserId: actor.userId,
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: actor.spaceId,
          organizationId,
          userId: actor.userId,
          role: "owner",
          createdAt: now,
        },
      });
    }),
  );
  afterAll(() =>
    runAsSystem("weather fixture cleanup", async () => {
      if (!db) return;
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: actor.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }),
  );
  it("authenticates push, deduplicates concurrent deliveries and rejects immutable batch conflicts", async () => {
    const { api, entry, input } = await setup();
    expect((await push(entry, "incorrect", { invalid: true })).status).toBe(401);
    const { token } = await api.trading.rotateWeatherPushToken(input);
    const results = await Promise.all([push(entry, token), push(entry, token)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const receipts = await Promise.all(results.map((r) => r.json()));
    expect(receipts.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(receipts[0].id).toBe(receipts[1].id);
    expect(
      (
        await push(entry, token, {
          ...forecast(),
          location: { ...forecast().location, name: "changed" },
        })
      ).status,
    ).toBe(409);
    const records = await api.trading.weatherForecasts({ ...input, limit: 5 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ transport: "push", fresh: true, forecast: forecast() });
    expect(
      JSON.stringify(await api.trading.interfaces({ workspaceId: input.workspaceId })),
    ).not.toContain(token);
    expect(
      (await api.trading.interfaces({ workspaceId: input.workspaceId }))[0]?.hasPushToken,
    ).toBe(true);
    await expect(
      runAsTenant(actor, () =>
        db.prisma.tradingWeatherForecast.update({
          where: { id: records[0]!.id },
          data: { batchId: "overwrite" },
        }),
      ),
    ).rejects.toThrow();
  });
  it("rotates and revokes scoped credentials, requires human confirmation, preserves history on removal", async () => {
    const { api, entry, input } = await setup();
    await expect(client(actor, false).trading.rotateWeatherPushToken(input)).rejects.toThrow();
    const first = await api.trading.rotateWeatherPushToken(input);
    expect((await push(entry, first.token)).status).toBe(200);
    const second = await api.trading.rotateWeatherPushToken(input);
    expect((await push(entry, first.token)).status).toBe(401);
    expect((await push(entry, second.token)).status).toBe(200);
    await api.trading.revokeWeatherPushToken(input);
    expect((await push(entry, second.token)).status).toBe(401);
    const third = await api.trading.rotateWeatherPushToken(input);
    await api.trading.removeInterface({
      workspaceId: input.workspaceId,
      id: entry.id,
      expectedRevision: 1,
    });
    expect((await push(entry, third.token)).status).toBe(401);
    expect(await api.trading.weatherForecasts({ ...input, limit: 5 })).toHaveLength(1);
  });
  it("bounds payloads and rejects forged scope, units, future and expired data, while stale retries remain idempotent", async () => {
    const { api, entry, input } = await setup();
    const { token } = await api.trading.rotateWeatherPushToken(input);
    expect((await push(entry, token, "x".repeat(WEATHER_MAX_BYTES))).status).toBe(413);
    expect((await push(entry, token, { ...forecast(), workspaceId: "forged" })).status).toBe(422);
    expect(
      (
        await push(entry, token, {
          ...forecast(),
          periods: [{ ...forecast().periods[0], windSpeedMps: 4 }],
        })
      ).status,
    ).toBe(422);
    expect(
      (await push(entry, token, createSyntheticWeatherForecast(new Date("2026-11-04T05:00:00Z"))))
        .status,
    ).toBe(422);
    expect(
      (await push(entry, token, createSyntheticWeatherForecast(new Date("2026-11-03T01:00:00Z"))))
        .status,
    ).toBe(422);
    const original = forecast();
    expect((await push(entry, token, original)).status).toBe(200);
    now = new Date("2026-11-05T01:00:00Z");
    expect((await push(entry, token, original)).status).toBe(200);
    expect((await api.trading.weatherForecasts({ ...input, limit: 5 }))[0]?.fresh).toBe(false);
  });
  it("orders by issue time, isolates tenants and gives bound Bots read-only weather access", async () => {
    const { api, entry, input, workspace } = await setup();
    const { token } = await api.trading.rotateWeatherPushToken(input);
    await push(entry, token);
    await push(entry, token, createSyntheticWeatherForecast(new Date("2026-11-04T00:00:00Z")));
    const records = await api.trading.weatherForecasts({ ...input, limit: 5 });
    expect(records.map((r) => r.forecast.issuedAt)).toEqual([
      "2026-11-04T01:00:00.000Z",
      "2026-11-04T00:00:00.000Z",
    ]);
    const other = { ...actor, spaceId: randomUUID() };
    await expect(client(other).trading.weatherForecasts({ ...input, limit: 5 })).rejects.toThrow();
    await expect(
      client({ ...actor, userId: randomUUID() }).trading.rotateWeatherPushToken(input),
    ).rejects.toThrow();
    expect(
      await runAsTenant(other, () =>
        db.prisma.tradingWeatherForecast.findMany({ where: { workspaceId: workspace.id } }),
      ),
    ).toEqual([]);
    expect(
      await runAsTenant(other, () =>
        db.prisma.tradingWeatherIngress.findMany({ where: { interfaceId: entry.id } }),
      ),
    ).toEqual([]);
    const botId = randomUUID();
    await runAsSystem("weather Bot fixture", () =>
      db.prisma.bot.create({
        data: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Synthetic weather reader",
          color: "blue",
          tradingRole: "spot",
        },
      }),
    );
    const { deskIds } = await api.trading.connectWorkspaceBot({ workspaceId: workspace.id, botId });
    const gateway = createTradingBotService(db.prisma, () => now);
    const query = { operation: "weather", deskId: deskIds[0] };
    expect(await runAsTenant(actor, () => gateway.call({ ...actor, botId }, query))).toEqual([
      records[0],
    ]);
    await expect(
      runAsTenant(actor, () => gateway.call({ ...actor, botId: randomUUID() }, query)),
    ).rejects.toThrow();
    await expect(
      runAsTenant(actor, () =>
        gateway.call({ ...actor, botId }, { operation: "pullWeather", deskId: deskIds[0] }),
      ),
    ).rejects.toThrow();
  });
  it("pulls through the real HTTP transport with encrypted auth and deduplicates a later push", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer synthetic-credential") {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(forecast()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { api, entry, input } = await setup(
        {
          transport: "http",
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/forecast`,
          method: "GET",
          query: {},
          body: "",
          auth: "bearer",
          authName: "",
        },
        "synthetic-credential",
      );
      await expect(client(actor, true, false).trading.pullWeather(input)).rejects.toThrow(
        "Weather pull failed",
      );
      const receipt = await api.trading.pullWeather(input);
      expect(receipt.duplicate).toBe(false);
      expect((await api.trading.weatherForecasts({ ...input, limit: 5 }))[0]?.transport).toBe(
        "pull",
      );
      const { token } = await api.trading.rotateWeatherPushToken(input);
      expect(await (await push(entry, token)).json()).toMatchObject({
        id: receipt.id,
        duplicate: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("rejects in-flight pulls after configuration changes and invalidates push on purpose changes", async () => {
    const { api, entry, input } = await setup({
      transport: "http",
      url: "https://weather.example.test",
      method: "GET",
      query: {},
      body: "",
      auth: "none",
      authName: "",
    });
    const { token } = await api.trading.rotateWeatherPushToken(input);
    const selected = await runAsTenant(actor, () => service().pullSource(actor, input));
    await api.trading.saveInterface({
      id: entry.id,
      workspaceId: entry.workspaceId,
      name: entry.name,
      purpose: "other",
      config: entry.config,
      expectedRevision: 1,
    });
    await expect(
      runAsTenant(actor, () => service().acceptPull(actor, input, selected.revision, forecast())),
    ).rejects.toThrow();
    expect((await push(entry, token)).status).toBe(401);
    expect(await api.trading.weatherForecasts({ ...input, limit: 5 })).toEqual([]);
  });
});

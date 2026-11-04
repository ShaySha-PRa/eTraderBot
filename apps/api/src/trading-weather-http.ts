import { WEATHER_MAX_BYTES, WEATHER_PUSH_PATH } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createTradingWeatherService } from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

export function mountTradingWeatherHttpRoutes(
  app: Hono,
  deps: { prisma: PrismaClient; clock?: () => Date },
) {
  const weather = createTradingWeatherService(deps.prisma, deps.clock);
  app.post(WEATHER_PUSH_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const token =
      /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    try {
      const result = await weather.receivePush(
        c.req.param("interfaceId") ?? "",
        token,
        async () => {
          const body = await readBoundedBody(c.req.raw, WEATHER_MAX_BYTES);
          if (body === null)
            throw new TradingError("PAYLOAD_TOO_LARGE", "Weather payload exceeds 256 KiB");
          try {
            return JSON.parse(body);
          } catch {
            throw new TradingError("INVALID_JSON", "Invalid JSON");
          }
        },
      );
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof TradingError) {
        const status =
          error.code === "FORBIDDEN"
            ? 401
            : error.code === "PAYLOAD_TOO_LARGE"
              ? 413
              : error.code === "INVALID_JSON"
                ? 400
                : error.code === "IDEMPOTENCY_CONFLICT"
                  ? 409
                  : 422;
        return c.json({ error: error.code, message: error.message }, status);
      }
      return c.json({ error: "WEATHER_INGEST_FAILED" }, 500);
    }
  });
}

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TradingDecimalSchema, TradingUnsignedDecimalSchema } from "./trading.js";

const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });
const percent = TradingUnsignedDecimalSchema.refine(
  (value) => Number(value) <= 100,
  "Percentage exceeds 100",
);
export const TradingWeatherPeriodSchema = z.strictObject({
  start: instant,
  end: instant,
  temperatureC: TradingDecimalSchema,
  windSpeedMps: TradingUnsignedDecimalSchema,
  relativeHumidityPct: percent,
  precipitationMm: TradingUnsignedDecimalSchema,
  solarIrradianceWm2: TradingUnsignedDecimalSchema,
  cloudCoverPct: percent,
});
/** A forecast issue is immutable. Units are explicit in field names, not inferred from values. */
export const TradingWeatherForecastSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    batchId: id,
    source: z.strictObject({
      sourceId: id,
      kind: z.enum(["synthetic", "company", "user"]),
      modelVersion: id,
    }),
    issuedAt: instant,
    validUntil: instant,
    location: z.strictObject({
      siteId: id,
      name: z.string().min(1).max(200),
      region: z.string().min(1).max(80),
      timezone: z.string().min(1).max(80),
    }),
    periods: z.array(TradingWeatherPeriodSchema).min(1).max(168),
  })
  .superRefine((value, ctx) => {
    const issued = Date.parse(value.issuedAt);
    if (Date.parse(value.validUntil) <= issued)
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Validity must follow forecast issue time",
      });
    let end = issued;
    for (const [index, period] of value.periods.entries()) {
      if (Date.parse(period.start) < end || Date.parse(period.end) <= Date.parse(period.start))
        ctx.addIssue({
          code: "custom",
          path: ["periods", index],
          message: "Forecast intervals must be ordered, non-overlapping and after issue time",
        });
      end = Date.parse(period.end);
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.location.timezone });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["location", "timezone"],
        message: "Unknown time zone",
      });
    }
  });
export const TradingWeatherRecordSchema = z.strictObject({
  id,
  workspaceId: id,
  interfaceId: id,
  interfaceName: z.string(),
  receivedAt: instant,
  transport: z.enum(["pull", "push"]),
  fresh: z.boolean(),
  forecast: TradingWeatherForecastSchema,
});
export const TradingWeatherIngestResultSchema = z.strictObject({
  id,
  batchId: id,
  duplicate: z.boolean(),
  receivedAt: instant,
});
export const WEATHER_PUSH_PATH = "/api/v1/trading/weather/:interfaceId";
export const WEATHER_MAX_BYTES = 256 * 1024;
export const tradingWeatherContract = {
  weatherForecasts: oc
    .input(
      z.strictObject({
        workspaceId: id,
        interfaceId: id.optional(),
        siteId: id.optional(),
        limit: z.number().int().min(1).max(20).default(5),
      }),
    )
    .output(z.array(TradingWeatherRecordSchema)),
  pullWeather: oc
    .input(z.strictObject({ workspaceId: id, interfaceId: id }))
    .output(TradingWeatherIngestResultSchema),
  rotateWeatherPushToken: oc
    .input(z.strictObject({ workspaceId: id, interfaceId: id }))
    .output(z.strictObject({ token: z.string(), path: z.string() })),
  revokeWeatherPushToken: oc
    .input(z.strictObject({ workspaceId: id, interfaceId: id }))
    .output(z.strictObject({ revoked: z.boolean() })),
};
export type TradingWeatherForecast = z.infer<typeof TradingWeatherForecastSchema>;
export type TradingWeatherRecord = z.infer<typeof TradingWeatherRecordSchema>;

import type { TradingWeatherForecast } from "@rakazo/contracts";
import { TradingWeatherForecastSchema } from "@rakazo/contracts";
import { tradingAssert } from "./algorithms.js";

/** Deterministic interface simulator; this does not perform meteorological inference. */
export function createSyntheticWeatherForecast(
  now: Date,
  region = "CN-SH",
  hours = 24,
): TradingWeatherForecast {
  tradingAssert(
    ["CN-SH", "CN-JS", "CN-SD"].includes(region),
    "INVALID_INPUT",
    "Unsupported simulation region",
  );
  tradingAssert(
    Number.isInteger(hours) && hours >= 1 && hours <= 168,
    "INVALID_INPUT",
    "Horizon must be 1–168 hours",
  );
  const hour = 3_600_000;
  const issued = Math.floor(now.getTime() / hour) * hour;
  const offset = ["CN-SH", "CN-JS", "CN-SD"].indexOf(region);
  const decimal = (value: number) => value.toFixed(2);
  return TradingWeatherForecastSchema.parse({
    schemaVersion: "1",
    batchId: `sim-${region}-${issued}-${hours}`,
    source: {
      sourceId: "internal-weather-simulator",
      kind: "synthetic",
      modelVersion: "weather-simulator-v1",
    },
    issuedAt: new Date(issued).toISOString(),
    validUntil: new Date(issued + 3 * hour).toISOString(),
    location: {
      siteId: `demo-${region}`,
      name: `Simulated site ${region}`,
      region,
      timezone: "Asia/Shanghai",
    },
    periods: Array.from({ length: hours }, (_, index) => {
      const start = issued + index * hour;
      const localHour = (new Date(start).getUTCHours() + 8) % 24;
      const daylight = Math.max(0, Math.sin(((localHour - 6) * Math.PI) / 12));
      return {
        start: new Date(start).toISOString(),
        end: new Date(start + hour).toISOString(),
        temperatureC: decimal(15 - offset * 2 + 8 * daylight),
        windSpeedMps: decimal(3 + offset + 2 * Math.sin((localHour * Math.PI) / 12) ** 2),
        relativeHumidityPct: decimal(75 - 20 * daylight),
        precipitationMm: decimal(localHour === 18 ? 0.4 : 0),
        solarIrradianceWm2: decimal(650 * daylight),
        cloudCoverPct: decimal(30 + offset * 10),
      };
    }),
  });
}
export function isWeatherFresh(forecast: TradingWeatherForecast, now: Date): boolean {
  return (
    Date.parse(forecast.issuedAt) <= now.getTime() &&
    Date.parse(forecast.validUntil) > now.getTime() &&
    forecast.periods.some((period) => Date.parse(period.end) > now.getTime())
  );
}

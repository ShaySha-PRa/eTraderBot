import { TradingWeatherForecastSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { createSyntheticWeatherForecast, isWeatherFresh } from "./weather.js";

const now = new Date("2026-11-04T01:10:00Z");
describe("weather model interface simulation", () => {
  it.each(["CN-SH", "CN-JS", "CN-SD"])(
    "generates deterministic hourly synthetic data for %s",
    (region) => {
      const result = createSyntheticWeatherForecast(now, region);
      expect(result).toEqual(
        createSyntheticWeatherForecast(new Date("2026-11-04T01:59:00Z"), region),
      );
      expect(result.source.kind).toBe("synthetic");
      expect(result.periods).toHaveLength(24);
      expect(result.location.region).toBe(region);
      expect(isWeatherFresh(result, now)).toBe(true);
      expect(isWeatherFresh(result, new Date(result.validUntil))).toBe(false);
      expect(isWeatherFresh(result, new Date("2026-11-04T00:59:00Z"))).toBe(false);
      expect(
        result.periods.every(
          (p) => Number(p.windSpeedMps) >= 0 && Number(p.solarIrradianceWm2) >= 0,
        ),
      ).toBe(true);
      expect(
        createSyntheticWeatherForecast(new Date("2026-11-04T02:00:00Z"), region).batchId,
      ).not.toBe(result.batchId);
    },
  );
  it("rejects unit/type ambiguity, invalid percentages, extra scope, overlapping periods and timezone errors", () => {
    const valid = createSyntheticWeatherForecast(now);
    for (const invalid of [
      { ...valid, workspaceId: "forged" },
      { ...valid, periods: [{ ...valid.periods[0], temperatureC: 20 }] },
      { ...valid, periods: [{ ...valid.periods[0], windSpeedMps: "-1" }] },
      { ...valid, periods: [{ ...valid.periods[0], relativeHumidityPct: "101" }] },
      { ...valid, periods: [valid.periods[0], valid.periods[0]] },
      { ...valid, validUntil: valid.issuedAt },
      { ...valid, location: { ...valid.location, timezone: "fake/timezone" } },
    ])
      expect(TradingWeatherForecastSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds the simulated output horizon and region", () => {
    expect(() => createSyntheticWeatherForecast(now, "CN-SH", 169)).toThrow();
    expect(() => createSyntheticWeatherForecast(now, "unknown")).toThrow();
    expect(createSyntheticWeatherForecast(now, "CN-SD", 168).periods).toHaveLength(168);
  });
});

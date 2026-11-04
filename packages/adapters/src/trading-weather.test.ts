import { TradingInterfaceConfigSchema, WEATHER_MAX_BYTES } from "@rakazo/contracts";
import { createSyntheticWeatherForecast } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { pullWeatherForecast } from "./trading-weather.js";

const forecast = createSyntheticWeatherForecast(new Date("2026-11-04T01:00:00Z"));
const resolveHostname = async () => [{ address: "203.0.113.10", family: 4 as const }];
function config(change: Record<string, unknown> = {}) {
  const result = TradingInterfaceConfigSchema.parse({
    transport: "http",
    url: "https://weather.example.test/forecast",
    ...change,
  });
  if (result.transport !== "http") throw new Error("HTTP fixture");
  return result;
}
describe("weather HTTP adapter", () => {
  it.each(["bearer", "header", "query"])(
    "applies %s credentials, query and POST body without changing data",
    async (auth) => {
      const fetch = vi.fn(async () => Response.json(forecast));
      const result = await pullWeatherForecast(
        config({
          method: "POST",
          body: '{"hours":24}',
          query: { region: "CN-SH" },
          auth,
          authName: "x-api-key",
        }),
        "synthetic-secret",
        { fetch, resolveHostname },
      );
      expect(result).toEqual(forecast);
      const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.searchParams.get("region")).toBe("CN-SH");
      expect(init.method).toBe("POST");
      expect(init.body).toBe('{"hours":24}');
      if (auth === "query") expect(url.searchParams.get("x-api-key")).toBe("synthetic-secret");
      else
        expect(
          new Headers(init.headers).get(auth === "bearer" ? "authorization" : "x-api-key"),
        ).toBe(auth === "bearer" ? "Bearer synthetic-secret" : "synthetic-secret");
    },
  );
  it.each([
    () => Response.json({ secret: "synthetic-secret" }, { status: 401 }),
    () => new Response("synthetic-secret"),
    () => Response.json({ ...forecast, periods: [] }),
    () => new Response("x".repeat(WEATHER_MAX_BYTES + 1)),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.test/steal" },
      }),
  ])(
    "rejects failed, invalid, excessive and redirected responses without leaking credentials",
    async (response) => {
      await expect(
        pullWeatherForecast(config(), undefined, {
          fetch: async () => response(),
          resolveHostname,
        }),
      ).rejects.toMatchObject({ code: "WEATHER_FETCH_FAILED" });
    },
  );
  it("requires private-network permission and always blocks metadata destinations", async () => {
    const fetch = vi.fn(async () => Response.json(forecast));
    await expect(
      pullWeatherForecast(config({ url: "http://127.0.0.1:8096/forecast" }), undefined, { fetch }),
    ).rejects.toThrow("Weather pull failed");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      pullWeatherForecast(config({ url: "http://169.254.169.254/latest" }), undefined, {
        fetch,
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      pullWeatherForecast(config({ url: "http://127.0.0.1:8096/forecast" }), undefined, {
        fetch,
        allowPrivateEndpoint: true,
      }),
    ).resolves.toEqual(forecast);
  });
  it("rejects transport header overrides before fetching", async () => {
    const fetch = vi.fn();
    await expect(
      pullWeatherForecast(config({ auth: "header", authName: "Host" }), "synthetic-secret", {
        fetch,
        resolveHostname,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

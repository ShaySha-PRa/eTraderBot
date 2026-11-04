import type { TradingInterface, TradingWeatherForecast } from "@rakazo/contracts";
import { TradingWeatherForecastSchema, WEATHER_MAX_BYTES } from "@rakazo/contracts";
import { TradingError } from "@rakazo/core";
import {
  applyCredential,
  isTransportHeader,
  readBoundedText,
  requireCredential,
} from "./connector-http.js";
import type { RemoteTransportDependencies, RemoteUrlPolicy } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

type HttpConfig = Extract<TradingInterface["config"], { transport: "http" }>;
/** Network translation only; scope, immutable receipts and authorization are owned by the service. */
export async function pullWeatherForecast(
  config: HttpConfig,
  credential: string | undefined,
  options: RemoteTransportDependencies & RemoteUrlPolicy = {},
  signal?: AbortSignal,
): Promise<TradingWeatherForecast> {
  const remote = createSafeRemoteFetch(options.fetch, options.resolveHostname, options);
  try {
    const url = new URL(config.url);
    for (const [key, value] of Object.entries(config.query)) url.searchParams.set(key, value);
    const auth = { type: config.auth, name: config.authName };
    requireCredential(auth, credential);
    if (auth.type === "header" && isTransportHeader(auth.name)) throw new Error("Transport header");
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.method === "POST") headers["content-type"] = "application/json";
    applyCredential(url, headers, auth, credential);
    const timeout = AbortSignal.timeout(15_000);
    const response = await remote(url, {
      method: config.method,
      headers,
      body: config.method === "POST" ? config.body : undefined,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Provider status");
    }
    const body = await readBoundedText(response, WEATHER_MAX_BYTES);
    if (body.truncated) throw new Error("Response too large");
    return TradingWeatherForecastSchema.parse(JSON.parse(body.text));
  } catch {
    // Never expose upstream bodies, URLs with query credentials, or provider error strings.
    throw new TradingError(
      "WEATHER_FETCH_FAILED",
      "Weather pull failed; check the endpoint, credential, network policy and forecast schema",
    );
  } finally {
    await remote.close();
  }
}

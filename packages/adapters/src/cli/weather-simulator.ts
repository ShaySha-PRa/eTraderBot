import { createServer } from "node:http";
import { createSyntheticWeatherForecast } from "@rakazo/core";
import { createSafeRemoteFetch } from "../remote-mcp.js";

// A development service that implements an internal weather model's output contract.
// No model weights or real-world observations are used.
const region = process.env.WEATHER_SIMULATOR_REGION ?? "CN-SH";
if (process.argv.includes("--push")) {
  const target = process.env.WEATHER_PUSH_URL;
  const token = process.env.WEATHER_PUSH_TOKEN;
  if (!target || !token) throw new Error("Set WEATHER_PUSH_URL and WEATHER_PUSH_TOKEN for a push");
  const remote = createSafeRemoteFetch(undefined, undefined, { allowPrivateEndpoint: true });
  try {
    const result = await remote(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(createSyntheticWeatherForecast(new Date(), region)),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    process.stdout.write(`Synthetic weather push: HTTP ${result.status}\n`);
    await result.body?.cancel();
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write("Synthetic weather push failed\n");
    process.exitCode = 1;
  } finally {
    await remote.close();
  }
} else {
  const port = Number(process.env.WEATHER_SIMULATOR_PORT ?? 8096);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET" || url.pathname !== "/v1/weather/forecast") {
      response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    try {
      const forecast = createSyntheticWeatherForecast(
        new Date(),
        url.searchParams.get("region") ?? region,
        Number(url.searchParams.get("hours") ?? 24),
      );
      response.end(JSON.stringify(forecast));
    } catch {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "Use region CN-SH, CN-JS or CN-SD and hours 1–168" }));
    }
  });
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `Synthetic weather model interface: http://127.0.0.1:${port}/v1/weather/forecast\n`,
    ),
  );
  for (const event of ["SIGINT", "SIGTERM"] as const) process.on(event, () => server.close());
}

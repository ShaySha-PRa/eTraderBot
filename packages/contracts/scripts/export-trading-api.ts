import { mkdir, writeFile } from "node:fs/promises";
import * as z from "zod";
import { TradingExternalErrorSchema, tradingExternalOperations } from "../src/trading.js";

import {
  TradingWeatherForecastSchema,
  TradingWeatherIngestResultSchema,
} from "../src/trading-weather.js";

const paths: Record<string, unknown> = {};
const error = z.toJSONSchema(TradingExternalErrorSchema, { target: "draft-2020-12" });
for (const [operationId, operation] of Object.entries(tradingExternalOperations)) {
  const input = z.toJSONSchema(operation.input, { target: "draft-2020-12", io: "input" });
  const pathNames = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const bodyProperties = { ...input.properties };
  for (const key of pathNames) delete bodyProperties[key];
  const responses: Record<string, unknown> = {
    "200": {
      description: "Validated result",
      content: {
        "application/json": {
          schema: z.toJSONSchema(operation.output, { target: "draft-2020-12" }),
        },
      },
    },
  };
  for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) {
    responses[String(status)] = {
      description: "Explicit failure; no fabricated result",
      content: { "application/json": { schema: error } },
    };
  }
  paths[operation.path] = {
    [operation.method]: {
      operationId,
      security: [{ bearerAuth: [] }],
      parameters: pathNames.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      })),
      ...(operation.method === "post"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    ...input,
                    properties: bodyProperties,
                    required: input.required?.filter((key) => !pathNames.includes(key)),
                  },
                },
              },
            },
          }
        : {}),
      responses,
    },
  };
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "eTraderBot external trading adapter",
    version: "1.0.0",
    description:
      "Company data and execution adapter contract. Prices: CNY/MWh; energy: MWh; power: MW. Decimal strings have at most six fractional digits. Sources and environments remain explicit. See the handoff for semantic requirements.",
  },
  servers: [{ url: "http://localhost:8095", description: "Example local adapter" }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  paths,
};
const directory = new URL("../../../docs/integration/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("eTraderBot-external-api.openapi.json", directory),
  `${JSON.stringify(document, null, 2)}\n`,
);

// Weather is a separate input feed, not a trading snapshot or execution channel.
const forecastSchema = z.toJSONSchema(TradingWeatherForecastSchema, { target: "draft-2020-12" });
await writeFile(
  new URL("eTraderBot-weather-api.openapi.json", directory),
  `${JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "eTraderBot weather forecast ingestion",
        version: "1.0.0",
        description:
          "Synthetic model output and company forecast integration. Temporal validation and batch immutability are enforced in addition to this schema. See eTraderBot-weather-api.md.",
      },
      components: {
        securitySchemes: { weatherPushToken: { type: "http", scheme: "bearer" } },
        schemas: { WeatherForecast: forecastSchema },
      },
      paths: {
        "/v1/weather/forecast": {
          get: {
            operationId: "simulateWeatherForecast",
            servers: [{ url: "http://127.0.0.1:8096" }],
            parameters: [
              {
                name: "region",
                in: "query",
                schema: { type: "string", enum: ["CN-SH", "CN-JS", "CN-SD"], default: "CN-SH" },
              },
              {
                name: "hours",
                in: "query",
                schema: { type: "integer", minimum: 1, maximum: 168, default: 24 },
              },
            ],
            responses: {
              "200": {
                description: "Deterministic synthetic forecast; no real model inference",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/WeatherForecast" } },
                },
              },
              "400": { description: "Invalid simulation parameters" },
            },
          },
        },
        "/api/v1/trading/weather/{interfaceId}": {
          post: {
            operationId: "pushWeatherForecast",
            servers: [{ url: "http://localhost:3100" }],
            security: [{ weatherPushToken: [] }],
            parameters: [
              { name: "interfaceId", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/WeatherForecast" } },
              },
            },
            responses: {
              "200": {
                description: "Stored or identical retry",
                content: {
                  "application/json": { schema: z.toJSONSchema(TradingWeatherIngestResultSchema) },
                },
              },
              "400": { description: "Invalid JSON" },
              "401": { description: "Missing, invalid or revoked scoped credential" },
              "409": { description: "Batch ID already has different content" },
              "413": { description: "Payload exceeds 256 KiB" },
              "422": { description: "Invalid schema, expired or future-issued forecast" },
              "500": { description: "Storage unavailable; retry same batch" },
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`,
);

import { mkdir, writeFile } from "node:fs/promises";
import * as z from "zod";
import { TradingExternalErrorSchema, tradingExternalOperations } from "../src/trading.js";

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

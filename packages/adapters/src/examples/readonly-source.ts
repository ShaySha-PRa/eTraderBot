import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ReadonlySourceData, ReadonlySourceResult } from "@rakazo/contracts";
import { ReadonlySourceDataSchema, ReadonlySourceQuerySchema } from "@rakazo/contracts";
import { z } from "zod";
import { readBoundedText } from "../connector-http.js";
import { combineSignals } from "../connector-safety.js";
import { createSafeRemoteFetch } from "../remote-mcp.js";

type SourceConfig = { workspaceId: string; credential: string; port?: number };
type BridgeConfig = SourceConfig & { sourceUrl: string; timeoutMs?: number };
type ErrorCode = Extract<ReadonlySourceResult, { ok: false }>["error"]["code"];

function failure(code: ErrorCode, message: string, retryable = false): ReadonlySourceResult {
  return { ok: false, error: { code, message, retryable } };
}

function authorized(request: IncomingMessage, credential: string) {
  const actual = Buffer.from(request.headers.authorization ?? ""),
    expected = Buffer.from(`Bearer ${credential}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function listen(server: Server, config: SourceConfig) {
  z.object({ workspaceId: z.string().min(1).max(128), credential: z.string().min(16) }).parse(
    config,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Example server did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** Two fictional hourly forecasts. They are neither observed consumption nor settlement evidence. */
export function syntheticLoadData(workspaceId: string): ReadonlySourceData {
  return {
    ok: true,
    source: {
      kind: "synthetic",
      sourceId: "synthetic-load-example",
      workspaceId,
      version: "synthetic-load-v1",
      generatedAt: "2026-11-07T16:00:00+08:00",
      timezone: "Asia/Shanghai",
    },
    date: "2026-11-08",
    candidateOnly: true,
    periods: [
      { start: "2026-11-08T00:00:00+08:00", end: "2026-11-08T01:00:00+08:00", forecastMWh: 12.5 },
      { start: "2026-11-08T01:00:00+08:00", end: "2026-11-08T02:00:00+08:00", forecastMWh: 13.5 },
    ],
  };
}

/** A standalone loopback-only fixture, using no application database or real observations. */
export async function startSyntheticLoadSource(config: SourceConfig) {
  const server = createServer((request, response) => {
    if (!authorized(request, config.credential))
      return send(response, 401, { error: "Unauthorized" });
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/forecast") return send(response, 404, { error: "Not found" });
    if (request.method !== "GET") return send(response, 405, { error: "Read only" });
    const query = ReadonlySourceQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return send(response, 400, { error: "Invalid query" });
    if (query.data.date !== "2026-11-08")
      return send(response, 404, { error: "No synthetic data" });
    send(response, 200, syntheticLoadData(config.workspaceId));
  });
  const handle = await listen(server, config);
  return { url: `${handle.baseUrl}/forecast`, close: handle.close };
}

/** MCP is only a protocol facade. The source URL, scope and credential never come from the model. */
export async function startReadonlySourceExample(config: BridgeConfig) {
  const source = new URL(config.sourceUrl);
  if (
    source.protocol !== "http:" ||
    source.hostname !== "127.0.0.1" ||
    source.username ||
    source.password ||
    source.search ||
    source.hash
  )
    throw new Error(
      "The synthetic example requires a fixed loopback HTTP source URL without credentials or query",
    );
  const timeoutMs = z
    .number()
    .int()
    .min(10)
    .max(30_000)
    .parse(config.timeoutMs ?? 2_000);
  const remote = createSafeRemoteFetch(undefined, undefined, { allowPrivateEndpoint: true });
  async function query(raw: unknown, signal?: AbortSignal): Promise<ReadonlySourceResult> {
    const parsed = ReadonlySourceQuerySchema.safeParse(raw);
    if (!parsed.success) return failure("INVALID_QUERY", "Use only date and the supported version");
    const url = new URL(source);
    url.searchParams.set("date", parsed.data.date);
    url.searchParams.set("version", parsed.data.version);
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await remote(url, {
        method: "GET",
        headers: { authorization: `Bearer ${config.credential}`, accept: "application/json" },
        signal: combineSignals(signal, deadline),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          return failure(
            "SOURCE_AUTH_FAILED",
            "Synthetic source rejected its configured credential",
          );
        if (response.status === 404)
          return failure("SOURCE_NO_DATA", "No synthetic data for that date/version");
        return failure("SOURCE_UNREACHABLE", "Synthetic source is unavailable", true);
      }
      const body = await readBoundedText(response, 64 * 1024);
      let data: unknown;
      try {
        data = JSON.parse(body.text);
      } catch {
        /* Invalid response, never return raw body. */
      }
      const checked = ReadonlySourceDataSchema.safeParse(data);
      if (
        body.truncated ||
        !checked.success ||
        checked.data.source.workspaceId !== config.workspaceId ||
        checked.data.source.version !== parsed.data.version ||
        checked.data.date !== parsed.data.date
      )
        return failure(
          "SOURCE_INVALID_RESPONSE",
          "Source returned invalid data, scope, date or version",
        );
      return checked.data;
    } catch {
      // Do not echo transport messages, URLs, credentials or unvalidated upstream bodies.
      return deadline.aborted
        ? failure("SOURCE_TIMEOUT", "Synthetic source query timed out", true)
        : failure("SOURCE_UNREACHABLE", "Synthetic source could not be reached", true);
    }
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (!authorized(request, config.credential))
        return send(response, 401, { error: "Unauthorized" });
      if (request.url !== "/mcp") return send(response, 404, { error: "Not found" });
      if (request.method !== "POST") return send(response, 405, { error: "Method not supported" });
      // Bound untrusted JSON before handing it to the SDK. This example has no uploads.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024) return send(response, 413, { error: "Request too large" });
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(response, 400, { error: "Invalid JSON" });
      }
      const mcp = new McpServer(
        { name: "synthetic-readonly-source", version: "1" },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "read_synthetic_load",
            description:
              "Read synthetic load forecasts for 2026-11-08, version synthetic-load-v1. Candidate reference only, not actual metering or formal business evidence. Scope is fixed by the connection; this tool grants no trading permission.",
            inputSchema: z.toJSONSchema(ReadonlySourceQuerySchema, { io: "input" }),
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
        const result =
          call.params.name === "read_synthetic_load"
            ? await query(call.params.arguments, extra.signal)
            : failure("INVALID_QUERY", "Unknown read-only tool");
        return {
          isError: !result.ok,
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      });
      response.once("close", () => {
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { error: "Synthetic example request failed" });
      else response.end();
    });
  });
  try {
    const handle = await listen(server, config);
    return {
      endpoint: `${handle.baseUrl}/mcp`,
      close: async () => {
        await handle.close();
        await remote.close();
      },
    };
  } catch (error) {
    await remote.close();
    throw error;
  }
}

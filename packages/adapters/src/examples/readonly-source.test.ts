import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { callRemoteMcpTool, listRemoteMcpTools } from "../remote-mcp.js";
import {
  startReadonlySourceExample,
  startSyntheticLoadSource,
  syntheticLoadData,
} from "./readonly-source.js";

const credential = "synthetic-readonly-example-token";
const workspaceId = "synthetic-business-a";
const query = { date: "2026-11-08", version: "synthetic-load-v1" };
const remoteFor = (endpoint: string) => ({
  endpoint,
  headers: { Authorization: `Bearer ${credential}` },
  allowPrivateEndpoint: true,
  allowHttpLocalhost: true,
  allowLocalHttpCredentials: true,
});

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return {
    url: `http://127.0.0.1:${address.port}/forecast`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe("standard readonly source example", () => {
  it("uses the real MCP protocol to return scoped, versioned synthetic candidate data", async () => {
    const source = await startSyntheticLoadSource({ workspaceId, credential });
    const bridge = await startReadonlySourceExample({
      workspaceId,
      credential,
      sourceUrl: source.url,
    });
    try {
      const remote = {
        endpoint: bridge.endpoint,
        headers: { Authorization: `Bearer ${credential}` },
        allowPrivateEndpoint: true,
        allowHttpLocalhost: true,
        allowLocalHttpCredentials: true,
      };
      const tools = await listRemoteMcpTools(remote);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ name: "read_synthetic_load", readOnly: true });
      const result = CallToolResultSchema.parse(
        await callRemoteMcpTool(remote, tools[0]!.name, query),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
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
          {
            start: "2026-11-08T00:00:00+08:00",
            end: "2026-11-08T01:00:00+08:00",
            forecastMWh: 12.5,
          },
          {
            start: "2026-11-08T01:00:00+08:00",
            end: "2026-11-08T02:00:00+08:00",
            forecastMWh: 13.5,
          },
        ],
      });
      // The shared connector removes text duplicated by structuredContent on success.
      expect(result.content).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(credential);
    } finally {
      await bridge.close();
      await source.close();
    }
  });

  it("refuses credentials, identity/URL overrides and unsupported inputs; offers no write method", async () => {
    let requests = 0;
    const source = await upstream((_req, res) => {
      requests++;
      res.end("{}");
    });
    const bridge = await startReadonlySourceExample({
      workspaceId,
      credential,
      sourceUrl: source.url,
    });
    try {
      await expect(
        listRemoteMcpTools({ ...remoteFor(bridge.endpoint), headers: {} }),
      ).rejects.toThrow();
      for (const args of [
        { ...query, workspaceId: "another-business" },
        { ...query, credential: "synthetic-other-key" },
        { ...query, sourceUrl: "http://127.0.0.1/other" },
        { ...query, botId: "another-bot" },
        { date: "2026-02-30" },
        { ...query, version: "future-version" },
      ]) {
        const result = CallToolResultSchema.parse(
          await callRemoteMcpTool(remoteFor(bridge.endpoint), "read_synthetic_load", args),
        );
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { ok: false, error: { code: "INVALID_QUERY" } },
        });
      }
      const write = CallToolResultSchema.parse(
        await callRemoteMcpTool(remoteFor(bridge.endpoint), "write_forecast", {}),
      );
      expect(write.isError).toBe(true);
      expect(requests).toBe(0);
      const fixture = await startSyntheticLoadSource({ workspaceId, credential });
      try {
        const response = await fetch(fixture.url, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(response.status).toBe(405);
      } finally {
        await fixture.close();
      }
    } finally {
      await bridge.close();
      await source.close();
    }
  });

  it("retries against the source instead of caching a failure or inventing a fallback", async () => {
    let unavailable = true;
    const source = await upstream((_request, response) => {
      if (unavailable) response.writeHead(503).end("Synthetic outage");
      else response.end(JSON.stringify(syntheticLoadData(workspaceId)));
    });
    const bridge = await startReadonlySourceExample({
      workspaceId,
      credential,
      sourceUrl: source.url,
    });
    try {
      const first = CallToolResultSchema.parse(
        await callRemoteMcpTool(remoteFor(bridge.endpoint), "read_synthetic_load", query),
      );
      expect(first).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "SOURCE_UNREACHABLE" } },
      });
      unavailable = false;
      const retried = CallToolResultSchema.parse(
        await callRemoteMcpTool(remoteFor(bridge.endpoint), "read_synthetic_load", query),
      );
      expect(retried).toMatchObject({
        isError: false,
        structuredContent: { ok: true, source: { workspaceId }, candidateOnly: true },
      });
    } finally {
      await bridge.close();
      await source.close();
    }
  });

  it.each([
    ["timeout", "SOURCE_TIMEOUT", true],
    ["unreachable", "SOURCE_UNREACHABLE", true],
    ["invalid JSON", "SOURCE_INVALID_RESPONSE", false],
    ["invalid shape", "SOURCE_INVALID_RESPONSE", false],
    ["wrong scope", "SOURCE_INVALID_RESPONSE", false],
    ["wrong date", "SOURCE_INVALID_RESPONSE", false],
    ["wrong version", "SOURCE_INVALID_RESPONSE", false],
    ["invalid intervals", "SOURCE_INVALID_RESPONSE", false],
    ["unauthorized", "SOURCE_AUTH_FAILED", false],
    ["no data", "SOURCE_NO_DATA", false],
  ] as const)(
    "reports %s without fabricated data or upstream credentials",
    async (mode, code, retryable) => {
      let calls = 0;
      const source = await upstream((req, res) => {
        calls++;
        expect(req.method).toBe("GET");
        expect(req.headers.authorization).toBe(`Bearer ${credential}`);
        expect(req.url).toBe("/forecast?date=2026-11-08&version=synthetic-load-v1");
        if (mode === "timeout") return;
        if (mode === "unauthorized" || mode === "no data") {
          res.writeHead(mode === "unauthorized" ? 401 : 404).end(credential);
          return;
        }
        if (mode === "invalid JSON") {
          res.end(`invalid JSON ${credential}`);
          return;
        }
        if (mode === "invalid shape") {
          res.end(JSON.stringify({ credential }));
          return;
        }
        const data = syntheticLoadData(workspaceId);
        if (mode === "wrong scope") data.source.workspaceId = "another-business";
        if (mode === "wrong date") data.date = "2026-11-09";
        if (mode === "invalid intervals") data.periods[0]!.end = data.periods[0]!.start;
        res.end(
          JSON.stringify(
            mode === "wrong version"
              ? { ...data, source: { ...data.source, version: "unknown" } }
              : data,
          ),
        );
      });
      if (mode === "unreachable") await source.close();
      const bridge = await startReadonlySourceExample({
        workspaceId,
        credential,
        sourceUrl: source.url,
        timeoutMs: 100,
      });
      try {
        const result = CallToolResultSchema.parse(
          await callRemoteMcpTool(remoteFor(bridge.endpoint), "read_synthetic_load", query),
        );
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { ok: false, error: { code, retryable } },
        });
        expect(result.structuredContent).not.toHaveProperty("periods");
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(result.structuredContent) },
        ]);
        expect(JSON.stringify(result)).not.toContain(credential);
        expect(calls).toBe(mode === "unreachable" ? 0 : 1);
      } finally {
        await bridge.close();
        if (mode !== "unreachable") await source.close();
      }
    },
  );
});

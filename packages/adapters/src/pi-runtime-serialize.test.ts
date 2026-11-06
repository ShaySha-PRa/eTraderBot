import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { serializeToolResult, toAgentTools } from "./pi-runtime-tools.js";

async function deliveredBusinessResult(result: unknown, strategy?: "current" | "retrieval") {
  const host = {
    queue: { push() {} },
    request: {
      runId: "synthetic-tool-delivery",
      contextStrategy: strategy,
      executeTool: async () => result,
    },
    signal: new AbortController().signal,
    depth: 0,
    pausePending: false,
    pendingShells: [],
    toolCallSeq: { value: 0 },
    toolCallBudget: { count: 0, exceeded: false, limit: 0, inFlight: 0 },
  } as unknown as ToolHost;
  const tool = toAgentTools(builtinAgentTools, host).find((t) => t.name === "use_tool")!;
  const delivered = await tool.execute("read-cycle", {
    name: "business_cycle",
    arguments: { operation: "read", cycleId: "synthetic-cycle" },
  });
  return delivered.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("serializeToolResult", () => {
  const skill = {
    name: "large-skill",
    description: "Large skill",
    source: "user",
    readOnly: false,
    content: `---\nname: large-skill\n---\n${"1. Step kept for skill_update.\n".repeat(600)}`,
  };

  it.each(["current", "retrieval"] as const)(
    "returns a large skill read verbatim with the %s strategy",
    (strategy) => {
      const text = serializeToolResult(skill, strategy, "skill_read", { name: skill.name });
      expect(text.length).toBeGreaterThan(12_000);
      expect(JSON.parse(text)).toEqual(skill);
    },
  );

  it.each(["current", "retrieval"] as const)(
    "keeps a full child read and its version with %s context",
    (strategy) => {
      const listing = {
        bot: { id: "child", instructionsVersion: "v2", instructions: "x".repeat(20_000) },
        bots: [],
        groups: [],
        sections: [],
        truncated: false,
      };
      expect(
        JSON.parse(serializeToolResult(listing, strategy, "list_fleet", { bot_id: "child" })),
      ).toEqual(listing);
    },
  );

  it("returns an opted-in MCP result verbatim", () => {
    const message = {
      body: `${"x".repeat(8_000)}https://sessions.example.test/join/abc${"y".repeat(8_000)}`,
    };
    const text = serializeToolResult(
      message,
      "retrieval",
      "mcp__mail__get_message",
      {},
      {
        ids: ["srv_mail"],
        slugs: ["mail"],
      },
    );
    expect(JSON.parse(text)).toEqual(message);
  });

  it("still bounds other large tool results", () => {
    const text = serializeToolResult({ output: "x".repeat(20_000) }, "current", "shell", {});
    expect(text.length).toBeLessThan(20_000);
  });

  it.each([undefined, "retrieval"] as const)(
    "delivers current evidence after large history without cutting serialized JSON (%s)",
    async (strategy) => {
      const history = Array.from({ length: 110 }, (_, index) => ({
        id: `synthetic-history-${index}`,
        streamKey: "metering",
        revision: index + 1,
        status: "confirmed",
        references: [`synthetic-source-${index}`],
        data: { kind: "metering", energyMwh: "80" },
      }));
      const corrected = {
        id: "synthetic-meter-correction",
        streamKey: "metering",
        revision: 111,
        status: "confirmed",
        references: [history.at(-1)!.id],
        data: { kind: "metering", energyMwh: "82" },
      };
      const result = {
        evidence: [...history, corrected],
        settlement: { energyAmountCny: "24320", references: [corrected.id], netProfitCny: null },
        tasks: [
          { ticketId: "synthetic-ticket", status: "review", unresolved: ["Verify correction"] },
        ],
      };
      expect(JSON.stringify(result).length).toBeGreaterThan(12_000);
      const actual = JSON.parse(await deliveredBusinessResult(result, strategy));
      expect(actual.evidence).toEqual(result.evidence);
      expect(actual.settlement).toEqual(result.settlement);
      expect(actual.tasks).toEqual(result.tasks);
    },
  );

  it("still shortens long prose before delivery while keeping the JSON and evidence ID", async () => {
    const text = await deliveredBusinessResult({
      id: "synthetic-evidence",
      summary: "Long synthetic investigation text. ".repeat(2_000),
    });
    expect(text.length).toBeLessThan(12_000);
    expect(JSON.parse(text)).toMatchObject({ id: "synthetic-evidence", contextTruncated: true });
    expect(text).toContain("omitted evidence is unavailable");
  });

  it("keeps the legacy current-strategy text cap", async () => {
    const text = await deliveredBusinessResult({ output: "x".repeat(20_000) }, "current");
    expect(text).toHaveLength(12_001);
    expect(text.endsWith("…")).toBe(true);
  });

  it("still bounds native text content supplied by a tool", async () => {
    const text = await deliveredBusinessResult({
      kind: "agent_tool_result",
      content: [{ type: "text", text: "x".repeat(20_000) }],
      details: {},
    });
    expect(text).toHaveLength(12_001);
    expect(text.endsWith("…")).toBe(true);
  });
});

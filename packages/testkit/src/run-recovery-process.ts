// Child process for run-recovery-process.postgres.test.ts only: the real API composition
// (HTTP, executor, in-memory job queue and reconciler) in its own OS process, so the test
// can SIGKILL one process mid-write and let a freshly started one recover the run.
// The runtime stands in for the model: each attempt re-issues the same business result.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";

const planFile = process.env.RUN_RECOVERY_PLAN!;
const origin = process.env.RUN_RECOVERY_ORIGIN!;
const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);

type Plan = Record<string, { ticketId: string; result: unknown; askBeforeComplete?: boolean }>;
const asked = new Set<string>();
const scripted = new ScriptedAgentRuntime();
const runtime: AgentRuntime = {
  describe: () => ({
    ...scripted.describe(),
    capabilities: { ...scripted.describe().capabilities, scripted: false },
  }),
  abort: (id) => scripted.abort(id),
  async *run(request) {
    emit({ event: "attempt", runId: request.runId });
    // The test releases the work once it has pinned the point it will interrupt.
    let work: Plan[string] | undefined;
    while (!work) {
      work = (JSON.parse(await readFile(planFile, "utf8")) as Plan)[request.botId];
      if (!work) await sleep(100);
    }
    if (work.askBeforeComplete && !asked.has(request.runId)) {
      asked.add(request.runId);
      emit({ event: "ask", runId: request.runId });
      yield { type: "ask", text: "Continue with the confirmed synthetic contracts?" };
      return;
    }
    const result = await request.executeTool!(
      "business_cycle",
      { operation: "complete", ticketId: work.ticketId, result: work.result },
      // A new provider call id in every process, as a restarted model would produce.
      `call-${process.pid}`,
    ).catch((error: unknown) => ({ thrown: error instanceof Error ? error.name : "error" }));
    emit({ event: "tool", runId: request.runId, result });
    yield { type: "done", text: "Synthetic business result submitted" };
  },
};

const { createApp } = await import("@rakazo/api/app");
const handles = await createApp({
  databaseUrl: process.env.DATABASE_URL!,
  realtimeDatabaseUrl: process.env.DATABASE_URL!,
  dataDir: await mkdtemp(path.join(tmpdir(), "rakazo-run-recovery-process-")),
  authUrl: origin,
  webOrigin: origin,
  sandboxProvider: "fake",
  modelConnectionFetch: createModelConnectionFixtureFetch([
    { provider: "openrouter", id: "scripted" },
  ]),
  agentRuntime: "scripted",
  wakeupDriver: "memory",
  signupsEnabled: "true",
  runtime,
});
const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
  emit({ event: "ready", port: info.port }),
);
const stop = async () => {
  server.close();
  await handles.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());

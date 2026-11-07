import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import type { Actor, BusinessCycleState, BusinessWorkResult } from "@rakazo/contracts";
import { currentBusinessEvidence } from "@rakazo/core";
import {
  createBusinessCycleService,
  createRepos,
  createTradingWorkspaceService,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5641";

async function fixture(runtime: AgentRuntime) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-live-business-auth-"));
  const { createApp } = await import("@rakazo/api/app");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    dataDir: dir,
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
  const close = async () => {
    await handles.stop();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const email = `${randomUUID()}@example.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "password12", name: "Synthetic authorization" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const db = asSystem(handles.prisma);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const membership = await db.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
    let actor: Actor = {
      userId: user.id,
      email,
      spaceId: membership.spaceId,
      isDeploymentOwner: false,
    };
    const workspace = await runAsSystem("create isolated live authorization fixture", () =>
      createTradingWorkspaceService(handles.prisma).createBusinessScope(actor, {
        name: "Synthetic authorization business",
        scope: {
          subjectId: "synthetic",
          subjectKind: "generator",
          accountId: "synthetic",
          assetId: "synthetic",
          region: "CN-SD",
          marketId: "synthetic",
          productId: "energy",
          environment: "simulation",
        },
        algorithmApproverUserId: user.id,
        tradeApproverUserId: user.id,
      }),
    );
    actor = { ...actor, spaceId: workspace.spaceId };
    const addBot = () =>
      runAsTenant(actor, () =>
        createRepos(handles.prisma).createBot(actor, {
          name: "Synthetic specialist",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          tradingRole: "mid_long_term",
          tradingWorkspaceId: workspace.id,
        }),
      );
    const bot = await addBot(); // Seed without a creation-intro run competing for the runtime.
    const cycle = await runAsTenant(actor, () =>
      createBusinessCycleService(handles.prisma).createDemo(actor, randomUUID()),
    );
    const response = (proc: string, input: unknown) =>
      handles.app.request(`/rpc/${proc}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          "x-rakazo-space-id": actor.spaceId,
        },
        body: JSON.stringify({ json: input }),
      });
    async function rpc<T>(proc: string, input: unknown): Promise<T> {
      const res = await response(proc, input);
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body.json as T;
    }
    await rpc("models/connect", {
      provider: "openrouter",
      modelId: "scripted",
      apiKey: "synthetic-runtime-key",
    });
    return { ...handles, actor, db, bot, cycle, addBot, rpc, response, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!enabled).sequential("05 live business authorization via HTTP and executor", () => {
  it.each(["unchanged", "membership_removed", "archived", "reassigned"] as const)(
    "a normally dispatched running specialist uses current authority: %s",
    async (change) => {
      let release!: () => void;
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      let ticketId = "";
      let result!: BusinessWorkResult;
      let otherEvidenceId = "";
      const delivered: unknown[] = [];
      const scripted = new ScriptedAgentRuntime();
      const runtime: AgentRuntime = {
        describe: () => ({
          ...scripted.describe(),
          capabilities: { ...scripted.describe().capabilities, scripted: false },
        }),
        abort: (id) => scripted.abort(id),
        async *run(request) {
          started = true;
          await resume;
          const submit = async (value: BusinessWorkResult, id: string) => {
            try {
              delivered.push(
                await request.executeTool!(
                  "business_cycle",
                  {
                    operation: "complete",
                    ticketId,
                    result: value,
                  },
                  id,
                ),
              );
            } catch (error) {
              delivered.push({ error: error instanceof Error ? error.message : String(error) });
            }
          };
          if (change === "unchanged")
            await submit({ ...result, evidenceIds: [otherEvidenceId] }, "missing-evidence");
          await submit(result, "live-authority-result");
          if (change === "unchanged")
            await submit({ ...result, summary: "Stale revision" }, "stale-version");
          yield { type: "done", text: "Synthetic authorization check ended" };
        },
      };
      const f = await fixture(runtime);
      try {
        const state = await f.rpc<BusinessCycleState>("businessCycle/assign", {
          cycleId: f.cycle.cycle.id,
          kind: "contract_coverage",
          dependsOn: [],
          requestId: randomUUID(),
        });
        ticketId = state.tasks[0]!.ticketId;
        otherEvidenceId = state.evidence.find((e) => e.streamKey !== "contracts")!.id;
        result = {
          evidenceIds: currentBusinessEvidence(state.evidence)
            .filter((e) => e.streamKey === "contracts")
            .map((e) => e.id),
          summary: "Synthetic sourced contract result",
          disagreements: [],
          unresolved: [],
          improvementProposal: null,
        };
        await expect.poll(() => started, { timeout: 15000 }).toBe(true);
        const run = await f.db.run.findFirstOrThrow({ where: { task: { ticketId } } });
        expect(run.status).toBe("running");
        expect(run.botId).toBe(f.bot.id);
        // Change only the isolated fixture's live authority after the actual executor started.
        // Keep the Run alive deliberately to exercise stale cached RunContext, not cancellation.
        if (change === "membership_removed")
          await f.db.spaceMember.delete({
            where: {
              spaceId_userId: { spaceId: f.actor.spaceId, userId: f.actor.userId },
            },
          });
        if (change === "archived")
          await f.db.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } });
        if (change === "reassigned") {
          const replacement = await f.addBot();
          await f.db.ticket.update({
            where: { id: ticketId },
            data: { assigneeBotId: replacement.id },
          });
        }
        const persisted = async () => ({
          evidence: await f.db.businessEvidence.findMany({
            where: { cycleId: f.cycle.cycle.id },
            orderBy: { id: "asc" },
          }),
          work: await f.db.businessCycleWork.findUniqueOrThrow({ where: { ticketId } }),
          ticket: await f.db.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
          comments: await f.db.ticketComment.findMany({
            where: { ticketId },
            orderBy: { id: "asc" },
          }),
        });
        const before = await persisted();
        release();
        await f.awaitIdle!();
        const after = await persisted();
        if (change === "unchanged") {
          expect(delivered[0]).toMatchObject({ code: "MISSING_EVIDENCE" });
          expect(delivered[1]).toMatchObject({
            tasks: [expect.objectContaining({ ticketId, status: "done" })],
          });
          expect(delivered[2]).toMatchObject({ code: "STALE_DATA" });
          expect(after.evidence.length - before.evidence.length).toBe(1);
          expect(after.comments.length - before.comments.length).toBe(1);
          expect(after.work.result).toEqual(result);
        } else {
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({ error: expect.any(String) });
          if (change === "reassigned") expect(delivered[0]).toMatchObject({ code: "FORBIDDEN" });
          else
            expect(delivered[0]).toMatchObject({ error: expect.stringContaining("unavailable") });
          expect(after).toEqual(before);
        }
        const calls = await f.db.runToolCall.findMany({
          where: { runId: run.id },
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        });
        expect(calls.map((c) => ({ name: c.name, status: c.status }))).toEqual(
          (change === "unchanged" ? ["failed", "completed", "failed"] : ["refused"]).map(
            (status) => ({ name: "business_cycle", status }),
          ),
        );
        expect(await f.db.run.count({ where: { task: { ticketId } } })).toBe(1);
        // An already-open page uses this same authenticated HTTP procedure. Membership
        // removal must be refused before reaching the business service, with no writes.
        if (change === "membership_removed") {
          const res = await f.response("businessCycle/complete", { ticketId, result });
          expect(res.status).toBe(401);
          expect(await res.json()).toMatchObject({ json: { code: "UNAUTHORIZED" } });
          expect(await persisted()).toEqual(before);
        }
      } finally {
        release();
        await f.close();
      }
    },
  );
});

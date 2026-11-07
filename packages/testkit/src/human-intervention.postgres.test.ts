import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { FakeSandboxProvider, ScriptedAgentRuntime } from "@rakazo/adapters";
import type { RunTraceDetail, ThreadSnapshot } from "@rakazo/contracts";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5591";
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(runtime?: AgentRuntime, sandbox?: FakeSandboxProvider) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-human-intervention-"));
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
    sandbox,
  });
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: "password12",
      name: "Synthetic intervention",
    }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  async function response(proc: string, input: unknown) {
    return handles.app.request(`/rpc/${proc}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(proc: string, input: unknown): Promise<T> {
    const res = await response(proc, input);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.json as T;
  }
  if (runtime)
    await rpc("models/connect", {
      provider: "openrouter",
      modelId: "scripted",
      apiKey: "synthetic-runtime-key",
    });
  const bot = await rpc<{ id: string }>("bots/create", {
    name: "Intervention",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await discardBotIntroRun(handles, cookie, bot.id);
  return {
    ...handles,
    bot,
    rpc,
    response,
    db: asSystem(handles.prisma),
    snapshot: () => rpc<ThreadSnapshot>("threads/get", { botId: bot.id }),
    close: async () => {
      await handles.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe
  .skipIf(!enabled)
  .sequential("human intervention via authenticated HTTP and executor", () => {
    it("persists a pending question and accepts concurrent/repeated answers without another resume", async () => {
      const scripted = new ScriptedAgentRuntime();
      const sandbox = new FakeSandboxProvider();
      const originalWrite = sandbox.writeFile.bind(sandbox);
      let writes = 0;
      sandbox.writeFile = async (...args) => {
        await originalWrite(...args);
        if (args[1].path.endsWith("answer.txt")) writes++;
      };
      const delivered: string[] = [];
      const runtime: AgentRuntime = {
        describe: () => ({
          ...scripted.describe(),
          capabilities: { ...scripted.describe().capabilities, scripted: false },
        }),
        abort: (id) => scripted.abort(id),
        async *run(request, context) {
          if (request.prompt.includes("Ask me which city to use")) {
            yield { type: "ask", text: "Which city should I use?" };
          } else if (request.prompt.includes("Shanghai")) {
            delivered.push(request.prompt);
            await request.executeTool!(
              "write_file",
              { path: "answer.txt", content: request.prompt },
              "answer-write",
            );
            yield { type: "done", text: "Recorded the supplied city" };
          } else {
            yield* scripted.run(request, context);
          }
        },
      };
      const f = await fixture(runtime, sandbox);
      try {
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Ask me which city to use",
        });
        await expect.poll(async () => (await f.snapshot()).run?.status).toBe("waiting_input");
        const before = await f.snapshot();
        const question = before.messages.find(
          (m) => m.runId === sent.runId && m.blocks.some((b) => b.kind === "ask"),
        );
        expect(question).toBeDefined();
        const answer = {
          botId: f.bot.id,
          runId: sent.runId,
          messageId: question!.id,
          answer: "Shanghai",
          clientNonce: randomUUID(),
        };
        const replies = await Promise.all([
          f.response("threads/answer", answer),
          f.response("threads/answer", answer),
        ]);
        expect(replies.map((r) => r.status)).toEqual([200, 200]);
        await expect
          .poll(
            async () => (await f.db.run.findUniqueOrThrow({ where: { id: sent.runId } })).status,
          )
          .toBe("completed");
        expect(
          (await f.response("threads/answer", { ...answer, clientNonce: randomUUID() })).status,
        ).toBe(200);
        expect((await f.response("threads/answer", { ...answer, answer: "Beijing" })).status).toBe(
          409,
        );
        const after = await f.snapshot();
        expect(after.messages.find((m) => m.id === question!.id)?.blocks).toContainEqual(
          expect.objectContaining({ kind: "ask", status: "answered", answer: "Shanghai" }),
        );
        expect(await f.db.attempt.count({ where: { runId: sent.runId } })).toBe(2);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toContain("Shanghai");
        expect(writes).toBe(1);
        const trace = await f.rpc<RunTraceDetail>("runs/detail", { runId: sent.runId });
        expect(trace.toolTrace.recorded).toBe(true);
        expect(trace.toolTrace.calls).toEqual([
          expect.objectContaining({ name: "write_file", status: "completed" }),
        ]);
        expect(JSON.stringify(trace)).not.toContain("Shanghai");
        expect(JSON.stringify(trace)).not.toContain("answer.txt");
        expect(
          await f.db.externalEffect.count({
            where: { runId: sent.runId, kind: "write_file", status: "completed" },
          }),
        ).toBe(1);
        expect(
          await f.db.event.count({ where: { runId: sent.runId, type: "thread.message.updated" } }),
        ).toBe(1);
      } finally {
        await f.close();
      }
    });
    it.each([
      { kind: "bearer", prompt: "show a secret card", name: "example_api" },
      { kind: "login", prompt: "show a login card", name: "example_login" },
    ])(
      "03 supplement: accepted $kind secret answers reject identical replay without saving or waking twice",
      async ({ kind, prompt, name }) => {
        const f = await fixture();
        const secret = "synthetic-secret-03-replay";
        const username = "synthetic-login-03@example.test";
        let enqueue: MockInstance<(typeof f.jobs)["enqueue"]> | undefined;
        try {
          const sent = await f.rpc<{ runId: string }>("threads/send", {
            botId: f.bot.id,
            text: prompt,
          });
          await expect.poll(async () => (await f.snapshot()).run?.status).toBe("waiting_input");
          await f.awaitIdle!();
          const question = (await f.snapshot()).messages.find(
            (m) =>
              m.runId === sent.runId &&
              m.blocks.some((b) => b.kind === "ask" && b.input === "secret"),
          )!;
          expect(question).toBeDefined();
          expect(question.blocks).toContainEqual(
            expect.objectContaining({
              kind: "ask",
              status: "pending",
              input: "secret",
              credential: expect.objectContaining({ name }),
            }),
          );
          enqueue = vi.spyOn(f.jobs, "enqueue"); // Observe the real queue; do not replace its behavior.
          const answer = {
            botId: f.bot.id,
            runId: sent.runId,
            messageId: question.id,
            clientNonce: randomUUID(),
            answer: kind === "login" ? "" : secret,
            ...(kind === "login"
              ? {
                  fields: [
                    { label: "Username", value: username, hidden: false },
                    { label: "Password", value: secret, hidden: true },
                  ],
                }
              : {}),
          };
          expect(await f.rpc("threads/answer", answer)).toEqual({ ok: true });
          await f.awaitIdle!();
          const acceptedRun = await f.db.run.findUniqueOrThrow({ where: { id: sent.runId } });
          expect(acceptedRun.status).toBe("completed");
          const persisted = async () => ({
            run: await f.db.run.findUniqueOrThrow({ where: { id: sent.runId } }),
            task: await f.db.task.findUniqueOrThrow({ where: { id: acceptedRun.taskId } }),
            attempts: await f.db.attempt.findMany({
              where: { runId: sent.runId },
              orderBy: { id: "asc" },
            }),
            messages: await f.db.message.findMany({
              where: { runId: sent.runId },
              orderBy: { seq: "asc" },
            }),
            events: await f.db.event.findMany({
              where: { runId: sent.runId },
              orderBy: { seq: "asc" },
            }),
            effects: await f.db.externalEffect.findMany({
              where: { runId: sent.runId },
              orderBy: { id: "asc" },
            }),
            credentials: await f.db.vaultCredential.findMany({
              where: { userId: acceptedRun.userId, name },
              orderBy: { id: "asc" },
            }),
            botSecrets: await f.db.botSecret.findMany({
              where: { botId: f.bot.id },
              orderBy: { id: "asc" },
            }),
            secrets: await f.db.secret.findMany({
              where: { userId: acceptedRun.userId },
              orderBy: { id: "asc" },
            }),
            taskCount: await f.db.task.count({ where: { botId: f.bot.id } }),
            runCount: await f.db.run.count({ where: { botId: f.bot.id } }),
          });
          const before = await persisted();
          expect(before.attempts).toHaveLength(2);
          expect(before.credentials).toHaveLength(1);
          expect(before.credentials[0]).toMatchObject({
            spaceId: acceptedRun.spaceId,
            name,
            ciphertext: expect.stringMatching(/^v2:/),
          });
          expect(before.messages.find((m) => m.id === question.id)?.blocks).toContainEqual(
            expect.objectContaining({
              kind: "ask",
              status: "answered",
              input: "secret",
              answer: "",
              answeredByUserId: acceptedRun.userId,
            }),
          );
          expect(before.events.filter((e) => e.type === "thread.message.updated")).toHaveLength(1);
          expect(before.effects.filter((e) => e.kind === "request_secret")).toEqual([
            expect.objectContaining({ status: "completed" }),
          ]);
          expect(JSON.stringify(before)).not.toContain(secret);
          expect(JSON.stringify(before)).not.toContain(username);
          const wakes = () =>
            enqueue!.mock.calls.filter(
              ([job]) => job.name === "run.continue" && job.payload.runId === sent.runId,
            );
          expect(wakes()).toHaveLength(1);
          const enqueues = enqueue.mock.calls.length;
          // Both requests are byte-equivalent to the accepted HTTP input, including clientNonce.
          for (const response of await Promise.all([
            f.response("threads/answer", answer),
            f.response("threads/answer", answer),
          ])) {
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.json).toMatchObject({
              code: "CONFLICT",
              message: "This prompt is no longer awaiting an answer",
            });
            expect(JSON.stringify(body)).not.toContain(secret);
          }
          await f.awaitIdle!();
          expect(wakes()).toHaveLength(1);
          expect(enqueue).toHaveBeenCalledTimes(enqueues);
          expect(await persisted()).toEqual(before); // Includes ciphertext, timestamps, history and Run state.
        } finally {
          enqueue?.mockRestore();
          await f.close();
        }
      },
    );

    it("stopping a waiting question rejects a late answer and preserves its history", async () => {
      const f = await fixture();
      try {
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Ask me which city to use",
        });
        await expect.poll(async () => (await f.snapshot()).run?.status).toBe("waiting_input");
        const before = await f.snapshot();
        const question = before.messages.find(
          (m) => m.runId === sent.runId && m.blocks.some((b) => b.kind === "ask"),
        )!;
        await f.rpc("threads/stop", { botId: f.bot.id });
        await f.rpc("threads/stop", { botId: f.bot.id });
        expect(
          (
            await f.response("threads/answer", {
              botId: f.bot.id,
              runId: sent.runId,
              messageId: question.id,
              answer: "Shanghai",
            })
          ).status,
        ).toBe(409);
        expect((await f.db.run.findUniqueOrThrow({ where: { id: sent.runId } })).status).toBe(
          "cancelled",
        );
        expect(await f.db.attempt.count({ where: { runId: sent.runId } })).toBe(1);
        expect((await f.snapshot()).messages.find((m) => m.id === question.id)?.blocks).toEqual(
          question.blocks,
        );
        expect(
          await f.db.event.count({ where: { runId: sent.runId, type: "run.cancelled" } }),
        ).toBe(1);
      } finally {
        await f.close();
      }
    });

    it("02: traces read success, returned errors and approval waits without payloads", async () => {
      const scripted = new ScriptedAgentRuntime();
      const sandbox = new FakeSandboxProvider();
      const readFile = sandbox.readFile.bind(sandbox);
      sandbox.readFile = async (...args) =>
        args[1].endsWith("invalid-private-file.txt") ? new Uint8Array([0xff]) : readFile(...args);
      const runtime: AgentRuntime = {
        describe: () => ({
          ...scripted.describe(),
          capabilities: { ...scripted.describe().capabilities, scripted: false },
        }),
        abort: (id) => scripted.abort(id),
        async *run(request, context) {
          if (!request.executeTool || !request.prompt.includes("Synthetic trace outcomes")) {
            yield* scripted.run(request, context);
            return;
          }
          await request.executeTool!("list_fleet", {}, "read-success");
          await request.executeTool!(
            "read_file",
            { path: "invalid-private-file.txt" },
            "read-failure",
          );
          await request.executeTool!(
            "unknown-private-tool-marker",
            { credential: "synthetic-private-token" },
            "refused",
          );
          yield { type: "done", text: "Trace fixture finished" };
        },
      };
      const f = await fixture(runtime, sandbox);
      try {
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Synthetic trace outcomes",
        });
        await expect
          .poll(
            async () => (await f.rpc<RunTraceDetail>("runs/detail", { runId: sent.runId })).status,
          )
          .toBe("waiting_input");
        const trace = await f.rpc<RunTraceDetail>("runs/detail", { runId: sent.runId });
        expect(trace.toolTrace).toMatchObject({ recorded: true, truncated: false });
        expect(trace.toolTrace.calls.map(({ name, status }) => ({ name, status }))).toEqual([
          { name: "list_fleet", status: "completed" },
          { name: "read_file", status: "failed" },
          { name: "unknown_tool", status: "waiting" },
        ]);
        expect(
          trace.toolTrace.calls.every(
            (call) => call.finishedAt !== null && call.durationMs !== null,
          ),
        ).toBe(true);
        expect(JSON.stringify(trace)).not.toContain("private");
      } finally {
        await f.close();
      }
    });

    it("stopping during a tool response retains the issued write but blocks the next tool", async () => {
      const release = barrier();
      const finished = barrier();
      const sandbox = new FakeSandboxProvider();
      const originalWrite = sandbox.writeFile.bind(sandbox);
      let stored = false;
      sandbox.writeFile = async (...args) => {
        await originalWrite(...args);
        if (args[1].path.endsWith("issued.txt")) {
          stored = true;
          await release.promise;
        }
      };
      const scripted = new ScriptedAgentRuntime();
      let subsequent: unknown = "not attempted";
      const runtime: AgentRuntime = {
        describe: () => ({
          ...scripted.describe(),
          capabilities: { ...scripted.describe().capabilities, scripted: false },
        }),
        abort: (id) => scripted.abort(id),
        async *run(request, context) {
          if (!request.prompt.includes("Synthetic stop race")) {
            yield* scripted.run(request, context);
            return;
          }
          try {
            await request.executeTool!(
              "write_file",
              { path: "issued.txt", content: "committed synthetic content" },
              "issued-write",
            );
          } catch (error) {
            if (!stored) throw error; /* An issued effect may report after cancellation. */
          }
          try {
            subsequent = await request.executeTool!("list_fleet", {}, "after-stop-read");
          } catch {
            subsequent = "refused";
          } finally {
            finished.resolve();
          }
          yield { type: "done", text: "Fixture ended" };
        },
      };
      const f = await fixture(runtime, sandbox);
      try {
        const sent = await f.rpc<{ runId: string }>("threads/send", {
          botId: f.bot.id,
          text: "Synthetic stop race",
        });
        await expect
          .poll(async () => (stored ? "issued" : (await f.snapshot()).run), { timeout: 10000 })
          .toBe("issued");
        await f.rpc("threads/stop", { botId: f.bot.id });
        expect((await f.snapshot()).run?.status).not.toBe("running");
        release.resolve();
        await finished.promise;
        expect(subsequent).toBe("refused");
        expect(
          [...sandbox.boxes.values()]
            .flatMap((box) => [...box.files.values()])
            .some(
              (file) => new TextDecoder().decode(file.content) === "committed synthetic content",
            ),
        ).toBe(true);
        const effect = await f.db.externalEffect.findFirst({
          where: { runId: sent.runId, kind: "write_file" },
        });
        expect(effect).not.toBeNull();
        expect(effect?.status).not.toBe("denied");
        const trace = await f.rpc<RunTraceDetail>("runs/detail", { runId: sent.runId });
        expect(trace.toolTrace.calls).toContainEqual(
          expect.objectContaining({ name: "list_fleet", status: "refused" }),
        );
        expect(trace.toolTrace.calls.find((call) => call.name === "write_file")?.status).toMatch(
          /^(completed|ambiguous)$/,
        );
        expect((await f.db.run.findUniqueOrThrow({ where: { id: sent.runId } })).status).toBe(
          "cancelled",
        );
      } finally {
        release.resolve();
        await f.close();
      }
    });
  });

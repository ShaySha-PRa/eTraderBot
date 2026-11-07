import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Execute the actual CLI from a temporary Git checkout. Only Docker/service launch are
// blocked at the process boundary; selection, Git, filesystem and PG behavior are real.
function checkout() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rakazo-startup-"));
  fixtures.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  for (const folder of [
    "scripts",
    "bin",
    "data",
    "packages/db/prisma/migrations",
    "packages/db/src/generated/prisma",
  ])
    mkdirSync(path.join(dir, folder), { recursive: true });
  for (const name of ["dev.mjs", "pnpm.mjs"])
    copyFileSync(path.join(repo, "scripts", name), path.join(dir, "scripts", name));
  writeFileSync(path.join(dir, "packages/db/package.json"), '{"type":"module"}');
  symlinkSync(
    path.join(repo, "packages/db/node_modules"),
    path.join(dir, "packages/db/node_modules"),
    "dir",
  );
  writeFileSync(path.join(dir, "packages/db/prisma/schema.prisma"), "// fixture");
  writeFileSync(path.join(dir, "packages/db/src/generated/prisma/client.ts"), "// fixture");
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(dir, "bin/docker"),
    `#!${process.execPath}\nprocess.stderr.write("DOCKER_MUST_NOT_RUN");process.exit(91);\n`,
  );
  writeFileSync(
    path.join(dir, "bin/pnpm"),
    `#!${process.execPath}\nimport fs from 'node:fs';if(process.argv.includes('dev'))fs.writeFileSync('launched.json', JSON.stringify({database:new URL(process.env.DATABASE_URL).pathname,dataDir:process.env.DATA_DIR,realtime:process.env.REALTIME_DATABASE_URL?new URL(process.env.REALTIME_DATABASE_URL).pathname:null}));\n`,
  );
  for (const name of ["docker", "pnpm"]) chmodSync(path.join(dir, "bin", name), 0o755);
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Startup fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-qb", `feature/${path.basename(dir)}`);
  function start(env: NodeJS.ProcessEnv, args: string[] = []) {
    const result = spawnSync(process.execPath, ["scripts/dev.mjs", ...args], {
      cwd: dir,
      env: {
        PATH: `${dir}/bin${path.delimiter}${process.env.PATH}`,
        NODE_ENV: "test",
        WEB_PORT: "5581",
        API_PORT: "3511",
        DATA_DIR: path.join(dir, "data"),
        ...env,
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { ...result, output: result.stdout + result.stderr };
  }
  return { dir, git, start };
}

describe.skipIf(process.platform === "win32")("development startup failure isolation", () => {
  it("refuses an unavailable configured target without Docker fallback or leaking credentials", () => {
    const fixture = checkout();
    const result = fixture.start({
      DATABASE_URL:
        "postgres://synthetic:do-not-log-password@127.0.0.1:1/selected?application_name=do-not-log-token",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("using the local container");
    expect(result.output).not.toContain("DOCKER_MUST_NOT_RUN");
    expect(result.output).not.toContain("do-not-log-password");
    expect(result.output).not.toContain("do-not-log-token");
    expect(result.output).toContain("127.0.0.1");
    expect(result.output).toContain("selected");
    expect(existsSync(path.join(fixture.dir, "launched.json"))).toBe(false);
  });
  it.each([
    { DATABASE_URL: "not-a-url-with-do-not-log-secret" },
    {
      DATABASE_URL: "postgres://synthetic:do-not-log-secret@127.0.0.1:1/a",
      DATABASE_MIGRATION_URL: "postgres://synthetic:do-not-log-secret@127.0.0.1:1/b",
    },
    { DATABASE_MIGRATION_URL: "postgres://synthetic:do-not-log-secret@127.0.0.1:1/a" },
    {
      DATABASE_URL: "postgres://synthetic:do-not-log-secret@127.0.0.1:1/a",
      REALTIME_DATABASE_URL: "postgres://synthetic:do-not-log-secret@127.0.0.1:1/b",
    },
  ])("refuses invalid or inconsistent target configuration before starting services", (env) => {
    const f = checkout();
    const result = f.start(env);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("DOCKER_MUST_NOT_RUN");
    expect(result.output).not.toContain("do-not-log-secret");
    expect(existsSync(path.join(f.dir, "launched.json"))).toBe(false);
  });
  it("requires an explicit matching file directory for --existing", () => {
    const f = checkout();
    const result = f.start(
      { DATABASE_URL: "postgres://synthetic:fake@127.0.0.1:1/a", DATA_DIR: "" },
      ["--existing"],
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("explicit absolute DATA_DIR");
  });
});

const databaseEnabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe
  .skipIf(!databaseEnabled || process.platform === "win32")
  .sequential("development startup preserves PostgreSQL business history", () => {
    const actor = {
      userId: randomUUID(),
      spaceId: randomUUID(),
      email: "startup@example.test",
      isDeploymentOwner: false,
    };
    let cycleId = "";
    let botId = "";
    const sourceUrl = process.env.DATABASE_MIGRATION_URL!;
    const now = new Date("2030-05-01T00:00:00.000Z");
    beforeAll(async () => {
      const {
        createDb,
        runAsSystem,
        runAsTenant,
        createRepos,
        createTradingWorkspaceService,
        createBusinessCycleService,
      } = await import("@rakazo/db");
      const db = createDb(sourceUrl);
      try {
        const org = randomUUID();
        await runAsSystem("isolated startup fixture", async () => {
          await db.prisma.user.create({
            data: { id: actor.userId, email: actor.email, name: "Synthetic startup operator" },
          });
          await db.prisma.organization.create({
            data: { id: org, name: "Synthetic startup", slug: org, createdAt: now },
          });
          await db.prisma.member.create({
            data: {
              id: randomUUID(),
              organizationId: org,
              userId: actor.userId,
              role: "owner",
              createdAt: now,
            },
          });
          await db.prisma.space.create({
            data: {
              id: actor.spaceId,
              organizationId: org,
              name: "Synthetic startup business",
              kind: "trading",
              createdByUserId: actor.userId,
            },
          });
          await db.prisma.spaceMember.create({
            data: {
              id: randomUUID(),
              organizationId: org,
              spaceId: actor.spaceId,
              userId: actor.userId,
              role: "owner",
              createdAt: now,
            },
          });
        });
        await runAsTenant(actor, async () => {
          const workspace = await createTradingWorkspaceService(db.prisma, () => now).create(
            actor,
            {
              name: "Synthetic startup business",
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
              algorithmApproverUserId: actor.userId,
              tradeApproverUserId: actor.userId,
            },
          );
          const bot = await createRepos(db.prisma).createBot(actor, {
            name: "Synthetic review",
            tradingRole: "review",
            tradingWorkspaceId: workspace.id,
            instructions: "",
            description: "",
            notifyOnFinish: true,
          });
          botId = bot.id;
          const board = await db.prisma.board.upsert({
            where: { spaceId: actor.spaceId },
            create: { spaceId: actor.spaceId },
            update: {},
          });
          await db.prisma.ticket.create({
            data: {
              spaceId: actor.spaceId,
              boardId: board.id,
              number: 1,
              title: "Preserve original evidence and attachment",
              assigneeBotId: bot.id,
              createdByUserId: actor.userId,
              description: "attachments/evidence.txt",
            },
          });
          const state = await createBusinessCycleService(db.prisma, () => now).createDemo(
            actor,
            "startup-p25",
          );
          cycleId = state.cycle.id;
        });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });
    const created: string[] = [];
    afterAll(async () => {
      const { createPool } = await import("@rakazo/db");
      const admin = createPool(sourceUrl);
      try {
        // Only databases observed as CLI-created in this disposable container are removed.
        for (const name of created)
          await admin.query(`DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}"`);
      } finally {
        await admin.end();
      }
    });
    function fixture() {
      const result = checkout();
      mkdirSync(path.join(result.dir, "data/attachments"));
      writeFileSync(
        path.join(result.dir, "data/attachments/evidence.txt"),
        "Synthetic attachment: P25 contract 100 MWh, 300 CNY/MWh.\n",
      );
      mkdirSync(path.join(result.dir, "packages/db/prisma/migrations/added"));
      writeFileSync(
        path.join(result.dir, "packages/db/prisma/migrations/added/migration.sql"),
        "-- additive fixture migration",
      );
      result.git("add", ".");
      result.git(
        "-c",
        "user.name=Startup fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "branch migration",
      );
      const env = { DATABASE_URL: sourceUrl, DATABASE_MIGRATION_URL: sourceUrl };
      return { ...result, env };
    }
    function launch(
      f: ReturnType<typeof fixture>,
      args: string[] = [],
      extra: Record<string, string> = {},
    ) {
      const result = f.start({ ...f.env, ...extra }, args);
      expect(result.status, result.output).toBe(0);
      const selected = JSON.parse(readFileSync(path.join(f.dir, "launched.json"), "utf8")) as {
        database: string;
        dataDir: string;
        realtime: string | null;
      };
      const name = selected.database.slice(1);
      if (name !== new URL(sourceUrl).pathname.slice(1) && !created.includes(name))
        created.push(name);
      return { result, selected };
    }
    async function history(database: string, dataDir: string) {
      const { createDb, runAsTenant, createBusinessCycleService } = await import("@rakazo/db");
      const url = new URL(sourceUrl);
      url.pathname = database;
      const db = createDb(url.href);
      try {
        return await runAsTenant(actor, async () => ({
          business: await createBusinessCycleService(db.prisma, () => now).get(actor, cycleId),
          bot: await db.prisma.bot.findUniqueOrThrow({ where: { id: botId } }),
          tickets: await db.prisma.ticket.findMany({
            where: { spaceId: actor.spaceId },
            orderBy: { id: "asc" },
          }),
          attachment: readFileSync(path.join(dataDir, "attachments/evidence.txt"), "utf8"),
        }));
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
    it("reuses the same branch database and readable attachments after restart and migration merge", async () => {
      const f = fixture();
      const first = launch(f);
      const before = await history(first.selected.database, first.selected.dataDir);
      expect(before.business.evidence.length).toBeGreaterThan(0);
      expect(before.tickets).toHaveLength(1);
      expect(launch(f).selected).toEqual(first.selected);
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
      const merged = launch(f);
      expect(merged.selected).toEqual(first.selected);
      expect(await history(merged.selected.database, merged.selected.dataDir)).toEqual(before);
    });
    it("refuses to replace a busy source database with an empty branch database", async () => {
      const { createPool } = await import("@rakazo/db");
      const f = fixture();
      const busy = createPool(sourceUrl);
      const connection = await busy.connect();
      try {
        const before = (await connection.query("SELECT datname FROM pg_database ORDER BY datname"))
          .rows;
        const result = f.start(f.env);
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).not.toContain("Created an empty");
        expect(existsSync(path.join(f.dir, "launched.json"))).toBe(false);
        expect(
          (await connection.query("SELECT datname FROM pg_database ORDER BY datname")).rows,
        ).toEqual(before);
      } finally {
        connection.release();
        await busy.end();
      }
    });

    it.each([null, "unrelated owner"])(
      "keeps ambiguous existing databases and files intact (marker %s)",
      async (marker) => {
        const { createPool } = await import("@rakazo/db");
        const f = fixture();
        const first = launch(f);
        const file = path.join(first.selected.dataDir, "attachments/evidence.txt");
        writeFileSync(file, "Branch-only evidence must survive an incomplete or foreign marker.");
        const before = await history(first.selected.database, first.selected.dataDir);
        const admin = createPool(sourceUrl);
        try {
          await admin.query(
            `COMMENT ON DATABASE "${first.selected.database.slice(1)}" IS ${marker === null ? "NULL" : "'unrelated owner'"}`,
          );
        } finally {
          await admin.end();
        }
        const result = f.start(f.env);
        expect(result.status, result.output).not.toBe(0);
        expect(await history(first.selected.database, first.selected.dataDir)).toEqual(before);
      },
    );

    it("pins an explicitly selected database and files while switching branches, preserving another live workspace", async () => {
      const { createPool } = await import("@rakazo/db");
      const f = fixture();
      const first = launch(f);
      writeFileSync(
        path.join(first.selected.dataDir, "attachments/evidence.txt"),
        "Evidence belonging only to the selected branch.",
      );
      const before = await history(first.selected.database, first.selected.dataDir);
      f.git("checkout", "-qb", "feature/other");
      const other = launch(f);
      const otherBefore = await history(other.selected.database, other.selected.dataDir);
      const url = new URL(sourceUrl);
      url.pathname = other.selected.database;
      const live = createPool(url.href);
      const connection = await live.connect();
      try {
        url.pathname = first.selected.database;
        const pinned = launch(f, ["--existing"], {
          DATABASE_URL: url.href,
          DATABASE_MIGRATION_URL: url.href,
          DATA_DIR: first.selected.dataDir,
        });
        expect(pinned.selected.database).toBe(first.selected.database);
        expect(pinned.selected.dataDir).toBe(first.selected.dataDir);
        expect(await history(first.selected.database, first.selected.dataDir)).toEqual(before);
        expect(await history(other.selected.database, other.selected.dataDir)).toEqual(otherBefore);
        expect((await connection.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
      } finally {
        connection.release();
        await live.end();
      }
    });

    it("routes realtime reads to the same selected data target", async () => {
      const f = fixture();
      const { selected } = launch(f, [], { REALTIME_DATABASE_URL: sourceUrl });
      expect(selected.realtime).toBe(selected.database);
    });

    it("refuses a missing branch attachment directory without replacing its database", async () => {
      const f = fixture();
      const first = launch(f);
      const before = await history(first.selected.database, first.selected.dataDir);
      const retained = `${first.selected.dataDir}-retained`;
      renameSync(first.selected.dataDir, retained);
      const result = f.start(f.env);
      expect(result.status, result.output).not.toBe(0);
      expect(existsSync(first.selected.dataDir)).toBe(false);
      expect(await history(first.selected.database, retained)).toEqual(before);
    });

    it("keeps orphaned branch files when their database is missing", async () => {
      const { createPool } = await import("@rakazo/db");
      const f = fixture();
      const first = launch(f);
      const file = path.join(first.selected.dataDir, "attachments/evidence.txt");
      writeFileSync(file, "The only remaining copy of an attachment.");
      const admin = createPool(sourceUrl);
      try {
        await admin.query(`DROP DATABASE "${first.selected.database.slice(1)}"`);
      } finally {
        await admin.end();
      }
      const result = f.start(f.env);
      expect(result.status, result.output).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe("The only remaining copy of an attachment.");
    });

    it("retains an incomplete file copy and refuses automatic replacement on retry", async () => {
      const { createPool } = await import("@rakazo/db");
      const f = fixture();
      const unreadable = path.join(f.dir, "data/unreadable.txt");
      writeFileSync(unreadable, "Preserve files after a copy failure.");
      chmodSync(unreadable, 0);
      const names = async () => {
        const pool = createPool(sourceUrl);
        try {
          return (
            await pool.query<{ datname: string }>(
              "SELECT datname FROM pg_database ORDER BY datname",
            )
          ).rows.map((r) => r.datname);
        } finally {
          await pool.end();
        }
      };
      try {
        const before = await names();
        const result = f.start(f.env);
        expect(result.status, result.output).not.toBe(0);
        const retained = (await names()).filter((name) => !before.includes(name));
        expect(retained).toHaveLength(1);
        created.push(...retained);
        expect(result.output).toContain("incomplete database and files were retained");
        const retry = f.start(f.env);
        expect(retry.status, retry.output).not.toBe(0);
        expect(retry.output).toContain("missing or conflicting ownership metadata");
        expect(await names()).toEqual([...before, ...retained].sort());
      } finally {
        chmodSync(unreadable, 0o600);
      }
    });
    it("starts the real Web/API/worker stack twice on the selected isolated database and files", async () => {
      const f = fixture();
      const original = await history(new URL(sourceUrl).pathname, path.join(f.dir, "data"));
      const runtime = new URL(sourceUrl);
      runtime.username = `startup_runtime_${randomUUID().slice(0, 8)}`;
      runtime.password = "synthetic-startup-runtime";
      async function freePort() {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No test port");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const [apiPort, webPort, supervisorPort] = await Promise.all([
          freePort(),
          freePort(),
          freePort(),
        ]);
        const web = `http://127.0.0.1:${webPort}`;
        const api = `http://127.0.0.1:${apiPort}`;
        const child = spawn(process.execPath, [path.join(repo, "scripts/dev.mjs"), "--existing"], {
          cwd: repo,
          detached: true,
          env: {
            ...process.env,
            NODE_ENV: "test",
            LOG_LEVEL: "info",
            DATABASE_URL: runtime.href,
            DATABASE_MIGRATION_URL: sourceUrl,
            REALTIME_DATABASE_URL: runtime.href,
            DATA_DIR: path.join(f.dir, "data"),
            API_PORT: String(apiPort),
            WEB_PORT: String(webPort),
            SUPERVISOR_PORT: String(supervisorPort),
            WEB_ORIGIN: web,
            BETTER_AUTH_URL: web,
            API_URL: api,
            API_PROXY_TARGET: api,
            SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisorPort}`,
            RAKAZO_DEV_HOST: "127.0.0.1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
        });
        child.stderr.on("data", (data) => {
          output += data.toString();
        });
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        try {
          const deadline = Date.now() + 60_000;
          let ready = false;
          while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) break;
            try {
              const response = await fetch(`${api}/ready`, { signal: AbortSignal.timeout(1000) });
              const page = await fetch(`${web}/app`, { signal: AbortSignal.timeout(1000) });
              if (response.ok && page.ok && output.includes("worker ready")) {
                expect(await response.json()).toEqual({ ok: true, degraded: false });
                expect(await page.text()).toContain("/src/main.tsx");
                ready = true;
                break;
              }
            } catch {
              /* Services are still starting. */
            }
            await sleep(250);
          }
          expect(ready, output.slice(-5000)).toBe(true);
          expect(output).toContain("Selected database target:");
          expect(await history(new URL(sourceUrl).pathname, path.join(f.dir, "data"))).toEqual(
            original,
          );
        } finally {
          const running = () => child.exitCode === null && child.signalCode === null;
          if (child.pid && running()) process.kill(-child.pid, "SIGTERM");
          await Promise.race([exited, sleep(5000)]);
          if (child.pid && running()) {
            process.kill(-child.pid, "SIGKILL");
            await exited;
          }
        }
      }
    }, 150_000);
  });

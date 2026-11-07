#!/usr/bin/env node
// `pnpm dev`: start the API, worker, web app, and sandbox supervisor for this checkout.
//
// Each checkout selects free ports and keeps its data target across migration merges.
// Configured database failures stop startup; managed Postgres is only the unconfigured default.
// New migration branches copy the base database and files, and refuse an incomplete copy.
// Ordinary startup never removes databases or files. --existing uses the configured database
// and absolute DATA_DIR as-is, independent of the checked-out branch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm, spawnPnpm } from "./pnpm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackage = path.join(root, "packages/db");
const require = createRequire(path.join(dbPackage, "package.json"));
const { Client } = require("pg");
const dotenv = require("dotenv");

const DEFAULT_PORTS = { web: 5173, api: 3100, supervisor: 7091 };
const PORT_STEP = 10;
const MANAGED = {
  container: "rakazo-dev-postgres",
  image: "postgres:18",
  port: 54318,
  owner: "rakazo",
  runtime: "rakazo_dev",
  database: "rakazo",
};
const SERVICES = ["@rakazo/api", "@rakazo/worker", "@rakazo/web", "@rakazo/sandbox-supervisor"];

const fileEnv = existsSync(path.join(root, ".env"))
  ? dotenv.parse(readFileSync(path.join(root, ".env")))
  : {};
const setting = (name) => process.env[name] ?? fileEnv[name];
const log = (message) => process.stdout.write(`[dev] ${message}\n`);
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help")) {
  process.stdout.write(
    "Usage: pnpm dev [--existing]\n--existing: use DATABASE_URL and its matching absolute DATA_DIR without branch selection.\nStartup never cleans up databases or files.\n",
  );
  process.exit(0);
}
if (args.some((arg) => arg !== "--existing"))
  throw new Error("Unknown startup option. Run pnpm dev --help.");
const existingTarget = args.includes("--existing");
if (existingTarget && (!setting("DATABASE_URL") || !path.isAbsolute(setting("DATA_DIR") || "")))
  throw new Error(
    "--existing requires DATABASE_URL and an explicit absolute DATA_DIR for its matching files.",
  );

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options }).trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  for (let block = 0; block < 50; block += 1) {
    const ports = Object.fromEntries(
      Object.entries(DEFAULT_PORTS).map(([name, port]) => [name, port + block * PORT_STEP]),
    );
    const free = await Promise.all(Object.values(ports).map(portFree));
    if (free.every(Boolean)) return ports;
  }
  throw new Error("No free port block found near the defaults. Set WEB_PORT and API_PORT in .env.");
}

function portEnv({ web, api, supervisor }) {
  const webUrl = `http://127.0.0.1:${web}`;
  const apiUrl = `http://127.0.0.1:${api}`;
  return {
    WEB_PORT: String(web),
    WEB_ORIGIN: webUrl,
    BETTER_AUTH_URL: webUrl,
    API_PORT: String(api),
    API_URL: apiUrl,
    API_PROXY_TARGET: apiUrl,
    SUPERVISOR_PORT: String(supervisor),
    SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisor}`,
  };
}

function databaseTarget(url) {
  try {
    const parsed = new URL(url);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error("Invalid target");
    // Match pg's effective connection parameters, including URL query overrides.
    const { host, port, database } = new Client({ connectionString: url }).connectionParameters;
    return JSON.stringify({ host, port, database });
  } catch {
    throw new Error(
      "Invalid database configuration. Use a PostgreSQL URL with an explicit database name.",
    );
  }
}

async function requireConnection(url, label) {
  const target = databaseTarget(url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch {
    // Driver errors can include credentials or URL query parameters.
    throw new Error(
      `${label} is unavailable: ${target}. No fallback will be used; check the server and credentials.`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.searchParams.delete("database");
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

async function startManagedPostgres() {
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error("Docker is unavailable for the managed local development database.");
  }
  const state = (() => {
    try {
      return run("docker", ["inspect", "--format", "{{.State.Running}}", MANAGED.container]);
    } catch {
      return null;
    }
  })();
  if (state === null) {
    log(`Starting a shared Postgres container (${MANAGED.container})`);
    run("docker", [
      "run",
      "-d",
      "--name",
      MANAGED.container,
      "--restart",
      "unless-stopped",
      "-e",
      `POSTGRES_USER=${MANAGED.owner}`,
      // Development only: the container is published on loopback and holds throwaway data.
      "-e",
      `POSTGRES_PASSWORD=${MANAGED.owner}`,
      "-e",
      `POSTGRES_DB=${MANAGED.database}`,
      "-p",
      `127.0.0.1:${MANAGED.port}:5432`,
      "-v",
      `${MANAGED.container}:/var/lib/postgresql`,
      MANAGED.image,
    ]);
  } else if (state !== "true") {
    run("docker", ["start", MANAGED.container]);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      run("docker", ["exec", MANAGED.container, "pg_isready", "-q", "-U", MANAGED.owner]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const server = `127.0.0.1:${MANAGED.port}`;
  return {
    url: `postgres://${MANAGED.runtime}:${MANAGED.runtime}@${server}/${MANAGED.database}`,
    migrationUrl: `postgres://${MANAGED.owner}:${MANAGED.owner}@${server}/${MANAGED.database}`,
  };
}

async function sharedDatabase() {
  const url = setting("DATABASE_URL");
  const migrationUrl = setting("DATABASE_MIGRATION_URL") || url;
  const realtimeUrl = setting("REALTIME_DATABASE_URL");
  if (!url) {
    if (migrationUrl || realtimeUrl)
      throw new Error(
        "DATABASE_URL is required with migration or realtime database configuration.",
      );
    log("No database URL configured; using the managed local development database");
    try {
      return await startManagedPostgres();
    } catch {
      throw new Error(
        "Could not start the managed development database. Check Docker and retry; no other database will be used.",
      );
    }
  }
  const target = databaseTarget(url);
  if (target !== databaseTarget(migrationUrl))
    throw new Error(
      `Runtime and migration URLs must select the same target: ${target} versus ${databaseTarget(migrationUrl)}.`,
    );
  if (realtimeUrl && target !== databaseTarget(realtimeUrl))
    throw new Error(
      "REALTIME_DATABASE_URL must select the same source server and database as DATABASE_URL.",
    );
  log(`Configured database target: ${target}`);
  // The existing migration command provisions a new runtime login on first startup.
  // Validate the owner now, then the selected runtime/realtime logins after migration.
  await requireConnection(migrationUrl, "Migration database");
  return { url, migrationUrl };
}

function migrationNames(ref) {
  return new Set(
    run("git", ["ls-tree", "--name-only", ref, "packages/db/prisma/migrations/"], { cwd: root })
      .split("\n")
      .filter(Boolean)
      .map((entry) => path.basename(entry)),
  );
}

function mainMigrations() {
  try {
    return migrationNames("origin/main");
  } catch {
    // Without main to compare against, any migration may be unmerged.
    throw new Error("Could not read origin/main. Run `git fetch origin main` and try again.");
  }
}

/** Migration folders in a checkout's working tree, committed or not. */
function checkoutMigrations(checkout) {
  const dir = path.join(checkout, "packages/db/prisma/migrations");
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()));
}

/** Migrations in this checkout that origin/main does not have. */
function branchOnlyMigrations(onMain) {
  return [...checkoutMigrations(root)].filter((name) => !onMain.has(name));
}

// Marks a finished branch database and records which repository and branch own it.
const BRANCH_DATABASE_COMMENT = "rakazo dev branch: ";

function branchDatabaseComment(branch) {
  return BRANCH_DATABASE_COMMENT + JSON.stringify({ repo: repositoryId(), branch });
}

function repositoryId() {
  return path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root }));
}

function currentBranch() {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
}

/** `<shared>_<branch>_<hash>`, within Postgres's 63-byte limit on names. */
function branchDatabaseName(sharedName, branch) {
  // Distinct branches can clean up to the same name; the hash keeps their databases apart.
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  const readable = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = `${sharedName}_${readable}`.slice(0, 63 - hash.length - 1).replace(/_+$/, "");
  return `${prefix}_${hash}`;
}

/** A branch database's files, kept apart so deleting one never removes a file main still uses. */
function branchDataDir(sharedDataDir, name) {
  return path.join(path.dirname(sharedDataDir), ".rakazo-dev-branches", name, "data");
}

async function branchDatabase(shared, sharedDataDir, create) {
  const sharedName = JSON.parse(databaseTarget(shared.migrationUrl)).database;
  const branch = currentBranch();
  const name = branchDatabaseName(sharedName, branch);
  if (/[\\/]/.test(name))
    throw new Error(
      "Branch database name cannot map safely to a file directory. Use --existing with an explicit DATA_DIR.",
    );
  const dataDir = branchDataDir(sharedDataDir, name);
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    // Two starts of the same branch take turns; the lock ends with this connection.
    await owner.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    const existing = await owner.query(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [name],
    );
    if (existing.rowCount) {
      let marker;
      try {
        const comment = existing.rows[0].comment;
        marker = comment?.startsWith(BRANCH_DATABASE_COMMENT)
          ? JSON.parse(comment.slice(BRANCH_DATABASE_COMMENT.length))
          : null;
      } catch {
        /* An unknown marker must never authorize replacement. */
      }
      if (marker?.repo !== repositoryId() || marker?.branch !== branch)
        throw new Error(
          `Existing database ${name} has missing or conflicting ownership metadata. Preserve it and its files; inspect or restore explicitly.`,
        );
      if (!existsSync(dataDir) || !statSync(dataDir).isDirectory())
        throw new Error(
          `Existing database ${name} is missing its data directory. Restore the matching files before starting.`,
        );
      return branchConnection(shared, name, dataDir);
    }
    // An orphan directory can be the only surviving copy of attachments.
    if (existsSync(path.dirname(dataDir)))
      throw new Error(
        `Branch files already exist for ${name}, but its database is missing. Preserve the files and restore the matching database.`,
      );
    if (!create) return shared;
    if (!existsSync(sharedDataDir) || !statSync(sharedDataDir).isDirectory())
      throw new Error(
        "Source data directory is missing. Restore it, or create it explicitly only if the source has no files.",
      );
    const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
    try {
      // No source clients may be active during a PostgreSQL template copy.
      await owner.query(`CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(sharedName)}`);
    } catch {
      throw new Error(
        `Could not copy the source database to ${name}. Check creation permissions and stop source clients before retrying; no empty replacement was created.`,
      );
    }
    try {
      cpSync(sharedDataDir, dataDir, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        force: false,
        errorOnExist: true,
      });
    } catch {
      // Retain both the database and partial files for operator-led recovery.
      // Without the completed marker, the next normal startup also refuses reuse.
      throw new Error(
        `Could not copy files for ${name}. The incomplete database and files were retained; inspect or restore before retrying.`,
      );
    }
    await owner.query(
      `COMMENT ON DATABASE ${identifier(name)} IS ${owner.escapeLiteral(branchDatabaseComment(branch))}`,
    );
    log(`Copied the shared database and files to ${name}`);
  } finally {
    await owner.end();
  }
  return branchConnection(shared, name, dataDir);
}

function branchConnection(shared, name, dataDir) {
  return {
    url: withDatabase(shared.url, name),
    migrationUrl: withDatabase(shared.migrationUrl, name),
    dataDir,
  };
}

function generateClientIfStale(env) {
  const client = path.join(dbPackage, "src/generated/prisma/client.ts");
  const schema = path.join(dbPackage, "prisma/schema.prisma");
  if (existsSync(client) && statSync(client).mtimeMs >= statSync(schema).mtimeMs) return;
  log("Generating the Prisma client");
  runPnpm(["--filter", "@rakazo/db", "generate"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

let ports = null;
if (!setting("WEB_PORT") && !setting("API_PORT")) {
  ports = await choosePorts();
  Object.assign(env, portEnv(ports));
}

// Checkouts that share a database also share its job queue, so any checkout's worker may write a
// file another checkout's API reads. A relative DATA_DIR resolves in the main checkout for all.
const mainCheckout = path.dirname(
  path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root })),
);
const sharedDataDir = path.resolve(mainCheckout, setting("DATA_DIR") || "./data");

const shared = { ...(await sharedDatabase()), dataDir: sharedDataDir };
if (existingTarget && (!existsSync(sharedDataDir) || !statSync(sharedDataDir).isDirectory()))
  throw new Error("The selected DATA_DIR is missing. Restore the matching files before starting.");
// A merged migration changes code ownership, not the user's data selection.
const database = existingTarget
  ? shared
  : await branchDatabase(shared, sharedDataDir, branchOnlyMigrations(mainMigrations()).length > 0);
log(
  `Selected database target: ${databaseTarget(database.url)}; data directory: ${JSON.stringify(database.dataDir)}`,
);
env.DATABASE_URL = database.url;
env.DATABASE_MIGRATION_URL = database.migrationUrl;
env.REALTIME_DATABASE_URL = withDatabase(
  setting("REALTIME_DATABASE_URL") || database.url,
  JSON.parse(databaseTarget(database.url)).database,
);
env.DATA_DIR = database.dataDir;

generateClientIfStale(env);
// Checkouts starting together would otherwise grant the server-wide runtime role at the same
// moment and fail. Advisory locks are per database, so every checkout locks the shared one.
const migrationLock = new Client({ connectionString: shared.migrationUrl });
await migrationLock.connect();
try {
  await migrationLock.query("SELECT pg_advisory_lock(hashtext('rakazo dev migrate'))");
  runPnpm(["db:migrate"], { cwd: root, env, stdio: "inherit" });
} finally {
  await migrationLock.end();
}

await requireConnection(database.url, "Selected runtime database");
if (env.REALTIME_DATABASE_URL !== database.url)
  await requireConnection(env.REALTIME_DATABASE_URL, "Selected realtime database");

if (ports) log(`Open http://127.0.0.1:${ports.web}`);
const turbo = spawnPnpm(
  ["exec", "turbo", "dev", "--env-mode=loose", ...SERVICES.map((name) => `--filter=${name}`)],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => turbo.kill(signal));
turbo.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

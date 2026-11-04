import { readFile } from "node:fs/promises";
import { WorkspaceMigrationChoiceSchema } from "@rakazo/contracts";
import { createDb, migrateWorkspaceOwnership, preflightWorkspaceMigration } from "@rakazo/db";

const args = process.argv.slice(2);
const planPath = args.find((arg) => arg.startsWith("--plan="))?.slice(7);
const fingerprint = args.find((arg) => arg.startsWith("--fingerprint="))?.slice(14);
if (!planPath || !process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly and pass --plan=<reviewed-json>. Default is read-only preflight. Applying also requires --apply --fingerprint=<preflight-hash> and stopped API/workers.",
  );
const plan = WorkspaceMigrationChoiceSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
const db = createDb(process.env.DATABASE_URL);
try {
  if (args.includes("--apply")) {
    if (!fingerprint) throw new Error("Applying requires the reviewed preflight fingerprint");
    process.stdout.write(
      `${JSON.stringify(await migrateWorkspaceOwnership(db.prisma, plan, fingerprint), null, 2)}\n`,
    );
  } else
    process.stdout.write(
      `${JSON.stringify(await preflightWorkspaceMigration(db.prisma, plan), null, 2)}\n`,
    );
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}

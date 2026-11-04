import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_MIGRATION_URL);
const migration = readFileSync(
  new URL("../prisma/migrations/20261123120000_business_spaces/migration.sql", import.meta.url),
  "utf8",
);

describe.skipIf(!enabled)("business Space migration (PostgreSQL)", () => {
  async function fixture(run: (db: pg.Client) => Promise<void>) {
    const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    const schema = `business_migration_${randomUUID().replaceAll("-", "")}`;
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema}; SET search_path = ${schema};
        CREATE TABLE spaces (id text PRIMARY KEY, name text NOT NULL);
        CREATE TABLE trading_workspaces (id text PRIMARY KEY, "spaceId" text REFERENCES spaces(id), name text);
        ALTER TABLE trading_workspaces ENABLE ROW LEVEL SECURITY;
        ALTER TABLE trading_workspaces FORCE ROW LEVEL SECURITY;
        INSERT INTO spaces VALUES ('scope-a', 'Personal'), ('scope-b', 'Existing business');
        INSERT INTO trading_workspaces VALUES ('legacy-a', 'scope-a', 'Synthetic retail'), ('legacy-b', 'scope-b', 'Legacy label');`);
      await run(db);
    } finally {
      await db.query("ROLLBACK");
      await db.query(`SET search_path = public; DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  }
  it("keeps identifiers, canonical names and the existing RLS configuration", () =>
    fixture(async (db) => {
      await db.query(migration);
      expect((await db.query("SELECT * FROM spaces ORDER BY id")).rows).toEqual([
        { id: "scope-a", name: "Synthetic retail" },
        { id: "scope-b", name: "Existing business" },
      ]);
      expect(
        (await db.query('SELECT id, "spaceId" FROM trading_workspaces ORDER BY id')).rows,
      ).toEqual([
        { id: "legacy-a", spaceId: "scope-a" },
        { id: "legacy-b", spaceId: "scope-b" },
      ]);
      expect(
        (
          await db.query(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'spaces'::regclass",
          )
        ).rows[0],
      ).toEqual({ relrowsecurity: false, relforcerowsecurity: false });
      expect(
        (
          await db.query(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'trading_workspaces'::regclass",
          )
        ).rows[0],
      ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await expect(
        db.query("INSERT INTO trading_workspaces VALUES ('duplicate', 'scope-a', 'Other account')"),
      ).rejects.toMatchObject({ code: "23505" });
    }));
  it("aborts ambiguous legacy ownership atomically without changing records or policies", () =>
    fixture(async (db) => {
      await db.query(
        "INSERT INTO trading_workspaces VALUES ('ambiguous', 'scope-a', 'Another account')",
      );
      const before = (await db.query("SELECT * FROM trading_workspaces ORDER BY id")).rows;
      await expect(db.query(migration)).rejects.toThrow(
        "Multiple legacy business configurations share a Space",
      );
      await db.query("ROLLBACK");
      expect((await db.query("SELECT * FROM trading_workspaces ORDER BY id")).rows).toEqual(before);
      expect((await db.query("SELECT name FROM spaces WHERE id = 'scope-a'")).rows[0].name).toBe(
        "Personal",
      );
      expect(
        (
          await db.query(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'trading_workspaces'::regclass",
          )
        ).rows[0].relrowsecurity,
      ).toBe(true);
    }));
});

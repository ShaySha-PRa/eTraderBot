-- Additive only: no existing business data or ownership is changed.
CREATE TABLE experience_packages (
 id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "sourceBotId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "lineageId" TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 "previousPackageId" TEXT UNIQUE, snapshot JSONB NOT NULL, "contentHash" TEXT NOT NULL,
 "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("userId","requestId"), UNIQUE("lineageId",version)
);
CREATE INDEX experience_packages_scope ON experience_packages("spaceId","userId",id);
CREATE TABLE experience_imports (
 id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "sourceSpaceId" TEXT NOT NULL, "sourceBotId" TEXT NOT NULL, "targetBotId" TEXT NOT NULL,
 "packageId" TEXT NOT NULL, "planHash" TEXT NOT NULL, snapshot JSONB NOT NULL, receipt JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("packageId","targetBotId")
);
CREATE INDEX experience_imports_target ON experience_imports("spaceId","userId",id);
CREATE INDEX experience_imports_source ON experience_imports("sourceSpaceId","userId",id);
CREATE TABLE experience_skills (
 id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "botId" TEXT NOT NULL,
 "importId" TEXT NOT NULL, "itemKey" TEXT NOT NULL, name TEXT NOT NULL, payload JSONB NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), "enabledAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("importId","itemKey")
);
CREATE UNIQUE INDEX experience_skills_bot_name ON experience_skills("botId",lower(name));
CREATE INDEX experience_skills_scope ON experience_skills("spaceId","userId","botId");
CREATE TABLE experience_handoff_events (
 id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "packageId" TEXT NOT NULL, "importId" TEXT, kind TEXT NOT NULL, payload JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX experience_handoff_events_scope ON experience_handoff_events("spaceId","userId","createdAt");
-- Snapshot immutability is enforced by the service; encryption rotation may rewrite ciphertext.
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['experience_packages','experience_imports','experience_skills','experience_handoff_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY experience_tenant ON %I USING ("spaceId"=NULLIF(current_setting(''app.space_id'',true),'''') AND "userId"=NULLIF(current_setting(''app.user_id'',true),''''))',tbl);
 EXECUTE format('CREATE POLICY experience_system ON %I USING ((SELECT app_rls_bypass()))',tbl);
 END LOOP;
END $$;

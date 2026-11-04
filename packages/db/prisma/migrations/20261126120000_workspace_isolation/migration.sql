BEGIN;
-- Expand only. Mixed legacy workspaces are quarantined, never guessed or relocated by DDL.
ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','trading'));
ALTER TABLE spaces ADD COLUMN "isolationPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trading_workspaces DISABLE ROW LEVEL SECURITY;
ALTER TABLE trading_desks DISABLE ROW LEVEL SECURITY;
ALTER TABLE trading_analyses DISABLE ROW LEVEL SECURITY;
ALTER TABLE bots DISABLE ROW LEVEL SECURITY;
UPDATE spaces s SET kind='trading' WHERE
 EXISTS (SELECT 1 FROM trading_workspaces w WHERE w."spaceId"=s.id) OR
 EXISTS (SELECT 1 FROM trading_desks d WHERE d."spaceId"=s.id) OR
 EXISTS (SELECT 1 FROM trading_analyses a WHERE a."spaceId"=s.id) OR
 EXISTS (SELECT 1 FROM bots b WHERE b."spaceId"=s.id AND b."tradingRole" IS NOT NULL);
UPDATE spaces s SET "isolationPending"=true WHERE s.kind='trading' AND
 EXISTS (SELECT 1 FROM bots b WHERE b."spaceId"=s.id AND b."tradingRole" IS NULL);

ALTER TABLE trading_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_desks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION enforce_bot_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_kind text; pending boolean;
BEGIN
 SELECT kind, "isolationPending" INTO target_kind, pending FROM spaces WHERE id=NEW."spaceId" FOR SHARE;
 IF pending OR (target_kind='general') <> (NEW."tradingRole" IS NULL) THEN
  RAISE EXCEPTION 'Bot role does not match an active workspace';
 END IF;
 IF TG_OP='UPDATE' AND OLD."tradingRole" IS DISTINCT FROM NEW."tradingRole" THEN
  RAISE EXCEPTION 'Bot trading role is immutable; create a new template';
 END IF;
 IF NEW."computerId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM computers c WHERE c.id=NEW."computerId" AND c."spaceId"=NEW."spaceId" AND c."userId"=NEW."userId"
 ) THEN RAISE EXCEPTION 'Computer belongs to another workspace'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_workspace_kind BEFORE INSERT OR UPDATE OF "spaceId", "tradingRole", "computerId" ON bots
 FOR EACH ROW EXECUTE FUNCTION enforce_bot_workspace_kind();

CREATE FUNCTION enforce_trading_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM spaces WHERE id=NEW."spaceId" AND kind='trading' AND NOT "isolationPending") THEN
  RAISE EXCEPTION 'Trading resources require an active trading workspace';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trading_workspace_kind BEFORE INSERT OR UPDATE OF "spaceId" ON trading_workspaces FOR EACH ROW EXECUTE FUNCTION enforce_trading_workspace_kind();
CREATE TRIGGER trading_desk_workspace_kind BEFORE INSERT OR UPDATE OF "spaceId" ON trading_desks FOR EACH ROW EXECUTE FUNCTION enforce_trading_workspace_kind();
CREATE TRIGGER trading_analysis_workspace_kind BEFORE INSERT OR UPDATE OF "spaceId" ON trading_analyses FOR EACH ROW EXECUTE FUNCTION enforce_trading_workspace_kind();

CREATE FUNCTION enforce_workspace_kind_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.kind<>NEW.kind AND (EXISTS(SELECT 1 FROM bots WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_workspaces WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_desks WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_analyses WHERE "spaceId"=NEW.id)) THEN
  RAISE EXCEPTION 'A workspace with existing content cannot change kind';
 END IF;
 IF NOT NEW."isolationPending" AND EXISTS(SELECT 1 FROM bots b WHERE b."spaceId"=NEW.id AND (NEW.kind='general') <> (b."tradingRole" IS NULL)) THEN
  RAISE EXCEPTION 'Resolve legacy Bot ownership before activating this workspace';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workspace_kind_change BEFORE UPDATE OF kind, "isolationPending" ON spaces FOR EACH ROW EXECUTE FUNCTION enforce_workspace_kind_change();

-- Keep existing owner/tenant policies, but constrain their permissive allSpaces path.
CREATE FUNCTION app_workspace_share_allowed(source_space text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT source_space=NULLIF(current_setting('app.space_id',true),'') OR
 EXISTS (SELECT 1 FROM spaces src JOIN spaces dst ON dst.id=NULLIF(current_setting('app.space_id',true),'')
 WHERE src.id=source_space AND src.kind='general' AND dst.kind='general');
$$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['agent_skills','mcp_servers','capability_installs'] LOOP
  EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING ((SELECT app_rls_bypass()) OR app_workspace_share_allowed("spaceId")) WITH CHECK ((SELECT app_rls_bypass()) OR app_workspace_share_allowed("spaceId"))', name||'_workspace_isolation',name);
 END LOOP;
END $$;

CREATE TABLE workspace_read_grants (
 id TEXT PRIMARY KEY, "sourceSpaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 "recipientSpaceId" TEXT NOT NULL, "recipientBotId" TEXT NOT NULL, "createdByUserId" TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('analysis','weather','memory','skill')), "resourceId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMP(3)
);
CREATE INDEX "workspace_read_grants_sourceSpaceId_idx" ON workspace_read_grants("sourceSpaceId");
CREATE INDEX "workspace_read_grants_recipientSpaceId_recipientBotId_idx" ON workspace_read_grants("recipientSpaceId","recipientBotId");
CREATE UNIQUE INDEX workspace_read_grants_active_unique ON workspace_read_grants("sourceSpaceId","recipientBotId",kind,"resourceId") WHERE "revokedAt" IS NULL;
CREATE TABLE workspace_access_audit (
 id TEXT PRIMARY KEY, "grantId" TEXT NOT NULL, "sourceSpaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 "actorUserId" TEXT NOT NULL, "actorBotId" TEXT, action TEXT NOT NULL CHECK(action IN ('granted','revoked','read','read_denied')),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "workspace_access_audit_sourceSpaceId_createdAt_idx" ON workspace_access_audit("sourceSpaceId","createdAt");
CREATE TRIGGER workspace_access_audit_immutable BEFORE UPDATE ON workspace_access_audit FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE FUNCTION protect_workspace_read_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'revokedAt') IS DISTINCT FROM (to_jsonb(OLD)-'revokedAt') OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
  RAISE EXCEPTION 'Read grant identity is immutable; create a new grant';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER workspace_read_grant_immutable BEFORE UPDATE ON workspace_read_grants FOR EACH ROW EXECUTE FUNCTION protect_workspace_read_grant();
ALTER TABLE workspace_read_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_read_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_read_grants_tenant ON workspace_read_grants USING (
 "createdByUserId"=NULLIF(current_setting('app.user_id',true),'') AND
 ("sourceSpaceId"=NULLIF(current_setting('app.space_id',true),'') OR "recipientSpaceId"=NULLIF(current_setting('app.space_id',true),''))
) WITH CHECK ("createdByUserId"=NULLIF(current_setting('app.user_id',true),'') AND "sourceSpaceId"=NULLIF(current_setting('app.space_id',true),''));
CREATE POLICY workspace_read_grants_system ON workspace_read_grants USING ((SELECT app_rls_bypass()));
ALTER TABLE workspace_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_access_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_access_audit_tenant ON workspace_access_audit FOR SELECT USING (
 "sourceSpaceId"=NULLIF(current_setting('app.space_id',true),'') AND EXISTS(SELECT 1 FROM space_members m WHERE m."spaceId"="sourceSpaceId" AND m."userId"=NULLIF(current_setting('app.user_id',true),'') AND m.role='owner')
);
CREATE POLICY workspace_access_audit_system ON workspace_access_audit USING ((SELECT app_rls_bypass()));

COMMIT;

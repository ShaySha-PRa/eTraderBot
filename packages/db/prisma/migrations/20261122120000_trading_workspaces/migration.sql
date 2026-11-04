BEGIN;
CREATE TABLE trading_workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  "ownerUserId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "algorithmApproverUserId" TEXT NOT NULL, "tradeApproverUserId" TEXT NOT NULL,
  scope JSONB NOT NULL CHECK (scope->>'environment' = 'simulation' AND NOT (scope ? 'stage')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trading_workspaces_spaceId_ownerUserId_idx ON trading_workspaces("spaceId", "ownerUserId");
CREATE TABLE trading_workspace_desks (
  "deskId" TEXT PRIMARY KEY REFERENCES trading_desks(id) ON DELETE CASCADE,
  "workspaceId" TEXT NOT NULL REFERENCES trading_workspaces(id) ON DELETE CASCADE
);
CREATE INDEX trading_workspace_desks_workspaceId_idx ON trading_workspace_desks("workspaceId");
CREATE TABLE trading_workspace_interfaces (
  id TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES trading_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, purpose TEXT NOT NULL, config JSONB NOT NULL, "secretId" TEXT,
  revision INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trading_workspace_interfaces_workspaceId_idx ON trading_workspace_interfaces("workspaceId");

-- Group legacy stages without changing immutable desks, approvals, receipts or Bot identities.
-- Policy identities are part of the grouping key, so different approval assignments never merge.
ALTER TABLE trading_desks DISABLE ROW LEVEL SECURITY;
INSERT INTO trading_workspaces (id, name, "spaceId", "ownerUserId", "algorithmApproverUserId", "tradeApproverUserId", scope, "createdAt")
SELECT 'legacy-' || md5(jsonb_build_array("spaceId", "ownerUserId", "algorithmApproverUserId", "tradeApproverUserId", scope - 'stage')::text),
       (scope->>'subjectId') || ' · ' || (scope->>'region'), "spaceId", "ownerUserId", "algorithmApproverUserId", "tradeApproverUserId", scope - 'stage', min("createdAt")
FROM trading_desks GROUP BY "spaceId", "ownerUserId", "algorithmApproverUserId", "tradeApproverUserId", scope - 'stage', scope->>'subjectId', scope->>'region';
INSERT INTO trading_workspace_desks ("deskId", "workspaceId")
SELECT id, 'legacy-' || md5(jsonb_build_array("spaceId", "ownerUserId", "algorithmApproverUserId", "tradeApproverUserId", scope - 'stage')::text) FROM trading_desks;
ALTER TABLE trading_desks ENABLE ROW LEVEL SECURITY;

ALTER TABLE trading_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_workspaces_tenant ON trading_workspaces USING (
  "spaceId" = NULLIF(current_setting('app.space_id',true),'') AND
  NULLIF(current_setting('app.user_id',true),'') IN ("ownerUserId","algorithmApproverUserId","tradeApproverUserId")
) WITH CHECK (
  "spaceId" = NULLIF(current_setting('app.space_id',true),'') AND
  NULLIF(current_setting('app.user_id',true),'') = "ownerUserId"
);
CREATE POLICY trading_workspaces_system ON trading_workspaces USING ((SELECT app_rls_bypass()));
ALTER TABLE trading_workspace_desks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_workspace_desks FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_workspace_desks_tenant ON trading_workspace_desks
  USING (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId") AND EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId" AND w."ownerUserId" = NULLIF(current_setting('app.user_id',true),'')) AND EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"));
CREATE POLICY trading_workspace_desks_system ON trading_workspace_desks USING ((SELECT app_rls_bypass()));
ALTER TABLE trading_workspace_interfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_workspace_interfaces FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_workspace_interfaces_tenant ON trading_workspace_interfaces
  USING (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId" AND w."ownerUserId" = NULLIF(current_setting('app.user_id',true),'')))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId" AND w."ownerUserId" = NULLIF(current_setting('app.user_id',true),'')));
CREATE POLICY trading_workspace_interfaces_system ON trading_workspace_interfaces USING ((SELECT app_rls_bypass()));
CREATE TRIGGER trading_workspaces_immutable BEFORE UPDATE ON trading_workspaces FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE TRIGGER trading_workspace_desks_immutable BEFORE UPDATE ON trading_workspace_desks FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();

COMMIT;

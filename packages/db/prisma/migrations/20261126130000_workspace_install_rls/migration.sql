-- Capability installs historically relied only on application predicates. Match skills/MCP
-- at the database boundary too; the restrictive workspace policy was added in the prior step.
ALTER TABLE capability_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_installs FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_installs_tenant ON capability_installs USING (
 "userId"=NULLIF(current_setting('app.user_id',true),'') AND (
 "spaceId"=NULLIF(current_setting('app.space_id',true),'') OR "allSpaces" OR EXISTS (
 SELECT 1 FROM capability_install_spaces a WHERE a."installId"=capability_installs.id
 AND a."spaceId"=NULLIF(current_setting('app.space_id',true),'')))
);
CREATE POLICY capability_installs_system ON capability_installs USING ((SELECT app_rls_bypass()));

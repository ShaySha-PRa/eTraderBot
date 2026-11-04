CREATE TABLE trading_weather_ingress (
  "interfaceId" TEXT PRIMARY KEY REFERENCES trading_workspace_interfaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE trading_weather_forecasts (
  id TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES trading_workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "interfaceId" TEXT NOT NULL,
  "interfaceName" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  transport TEXT NOT NULL CHECK (transport IN ('pull','push')),
  "contentHash" TEXT NOT NULL,
  forecast JSONB NOT NULL,
  UNIQUE ("interfaceId", "batchId")
);
CREATE INDEX trading_weather_forecasts_workspaceId_issuedAt_idx ON trading_weather_forecasts("workspaceId", "issuedAt");
CREATE TRIGGER trading_weather_forecasts_immutable BEFORE UPDATE ON trading_weather_forecasts
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
ALTER TABLE trading_weather_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_weather_forecasts FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_weather_tenant ON trading_weather_forecasts
  USING (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_workspaces w WHERE w.id = "workspaceId" AND w."ownerUserId" = NULLIF(current_setting('app.user_id',true),'')));
CREATE POLICY trading_weather_system ON trading_weather_forecasts USING ((SELECT app_rls_bypass()));
ALTER TABLE trading_weather_ingress ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_weather_ingress FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_weather_key_tenant ON trading_weather_ingress
  USING (EXISTS (SELECT 1 FROM trading_workspace_interfaces i WHERE i.id = "interfaceId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_workspace_interfaces i WHERE i.id = "interfaceId"));
CREATE POLICY trading_weather_key_system ON trading_weather_ingress USING ((SELECT app_rls_bypass()));

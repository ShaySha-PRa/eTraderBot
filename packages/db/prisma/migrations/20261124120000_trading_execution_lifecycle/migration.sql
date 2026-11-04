-- Additive: old executors continue to settle immediate full fills with zero reservations.
ALTER TABLE trading_grants ADD COLUMN "reservedCny" DECIMAL(36,6) NOT NULL DEFAULT 0,
  ADD COLUMN "allowCancellation" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT trading_grant_capacity CHECK ("reservedCny" >= 0 AND "usedCny" + "reservedCny" <= "cumulativeLimitCny");
DROP TRIGGER trading_grants_immutable ON trading_grants;
CREATE TRIGGER trading_grants_immutable BEFORE UPDATE ON trading_grants
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence('usedCny','reservedCny','revokedAt');
ALTER TABLE trading_executions ADD COLUMN "simulationScenario" TEXT NOT NULL DEFAULT 'immediate_fill';
CREATE TABLE trading_simulation_policies (
  "deskId" TEXT PRIMARY KEY REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  scenario TEXT NOT NULL DEFAULT 'immediate_fill' CHECK (scenario IN ('immediate_fill','partial_fill','timeout','rejected','pending','cancel_timeout','unavailable'))
);
CREATE TABLE trading_execution_events (
  id TEXT PRIMARY KEY,
  "executionId" TEXT NOT NULL REFERENCES trading_executions(id) ON DELETE CASCADE ON UPDATE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 1),
  receipt JSONB NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('reconcile','cancel')),
  "clientRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("executionId", sequence), UNIQUE ("executionId", "clientRequestId")
);
CREATE TRIGGER trading_execution_events_immutable BEFORE UPDATE ON trading_execution_events
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
ALTER TABLE trading_simulation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_simulation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_policy_tenant ON trading_simulation_policies
  USING (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"));
CREATE POLICY trading_policy_system ON trading_simulation_policies USING ((SELECT app_rls_bypass()));
ALTER TABLE trading_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_execution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_event_tenant ON trading_execution_events
  USING (EXISTS (SELECT 1 FROM trading_executions e WHERE e.id = "executionId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_executions e WHERE e.id = "executionId"));
CREATE POLICY trading_event_system ON trading_execution_events USING ((SELECT app_rls_bypass()));

CREATE TABLE trading_desks (
  id TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "ownerUserId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "algorithmApproverUserId" TEXT NOT NULL,
  "tradeApproverUserId" TEXT NOT NULL,
  scope JSONB NOT NULL CHECK (scope->>'environment' = 'simulation'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trading_desks_spaceId_ownerUserId_idx" ON trading_desks("spaceId", "ownerUserId");
CREATE INDEX "trading_desks_spaceId_algorithmApproverUserId_idx" ON trading_desks("spaceId", "algorithmApproverUserId");
CREATE INDEX "trading_desks_spaceId_tradeApproverUserId_idx" ON trading_desks("spaceId", "tradeApproverUserId");
CREATE TABLE trading_versions (
  id TEXT PRIMARY KEY,
  "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "algorithmVersionId" TEXT NOT NULL, "artifactHash" TEXT NOT NULL, artifact TEXT NOT NULL,
  parameters JSONB NOT NULL, validation JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','retired')),
  "approvedByUserId" TEXT, "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'approved' AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL) OR status != 'approved')
);
CREATE UNIQUE INDEX "trading_versions_deskId_algorithmVersionId_key" ON trading_versions("deskId", "algorithmVersionId");
CREATE TABLE trading_intents (
  id TEXT PRIMARY KEY,
  "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "versionId" TEXT NOT NULL REFERENCES trading_versions(id) ON UPDATE CASCADE,
  "analysisId" TEXT NOT NULL, intent JSONB NOT NULL, snapshot JSONB NOT NULL, parameters JSONB NOT NULL,
  "grossNotionalCny" DECIMAL(36,6) NOT NULL CHECK ("grossNotionalCny" >= 0),
  "approvedByUserId" TEXT, "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trading_intents_deskId_createdAt_idx" ON trading_intents("deskId", "createdAt");
CREATE TABLE trading_grants (
  id TEXT PRIMARY KEY,
  "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "versionId" TEXT NOT NULL REFERENCES trading_versions(id) ON UPDATE CASCADE,
  "perTradeLimitCny" DECIMAL(36,6) NOT NULL CHECK ("perTradeLimitCny" > 0),
  "cumulativeLimitCny" DECIMAL(36,6) NOT NULL CHECK ("cumulativeLimitCny" >= "perTradeLimitCny"),
  "usedCny" DECIMAL(36,6) NOT NULL DEFAULT 0 CHECK ("usedCny" >= 0 AND "usedCny" <= "cumulativeLimitCny"),
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "approvedByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trading_grants_deskId_createdAt_idx" ON trading_grants("deskId", "createdAt");
CREATE TABLE trading_executions (
  id TEXT PRIMARY KEY,
  "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "intentId" TEXT NOT NULL REFERENCES trading_intents(id) ON UPDATE CASCADE,
  "grantId" TEXT REFERENCES trading_grants(id) ON UPDATE CASCADE,
  "clientRequestId" TEXT NOT NULL, "requestHash" TEXT NOT NULL, receipt JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "trading_executions_intentId_key" ON trading_executions("intentId");
CREATE UNIQUE INDEX "trading_executions_deskId_clientRequestId_key" ON trading_executions("deskId", "clientRequestId");
CREATE INDEX "trading_executions_deskId_createdAt_idx" ON trading_executions("deskId", "createdAt");
CREATE TABLE trading_audit (
  id TEXT PRIMARY KEY, "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "actorUserId" TEXT NOT NULL, kind TEXT NOT NULL, "recordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trading_audit_deskId_createdAt_idx" ON trading_audit("deskId", "createdAt");

ALTER TABLE trading_desks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_desks FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_desks_tenant ON trading_desks
  USING ("spaceId" = NULLIF(current_setting('app.space_id',true),'') AND
    NULLIF(current_setting('app.user_id',true),'') IN ("ownerUserId","algorithmApproverUserId","tradeApproverUserId"))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id',true),'') AND
    NULLIF(current_setting('app.user_id',true),'') IN ("ownerUserId","algorithmApproverUserId","tradeApproverUserId"));
CREATE POLICY trading_desks_system ON trading_desks USING ((SELECT app_rls_bypass()));
DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['trading_versions','trading_intents','trading_grants','trading_executions','trading_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('CREATE POLICY trading_child_tenant ON %I USING (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId")) WITH CHECK (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"))',relation_name);
    EXECUTE format('CREATE POLICY trading_child_system ON %I USING ((SELECT app_rls_bypass()))',relation_name);
  END LOOP;
END $$;

-- Approval and accounting state may advance; reviewed content is immutable.
-- DELETE remains available for normal account/Space cascade cleanup.
CREATE FUNCTION trading_protect_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - COALESCE(TG_ARGV, ARRAY[]::TEXT[])) IS DISTINCT FROM (to_jsonb(OLD) - COALESCE(TG_ARGV, ARRAY[]::TEXT[])) THEN
    RAISE EXCEPTION 'Trading evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('trading_versions','trading_intents') THEN
    IF OLD."approvedAt" IS NOT NULL AND
      (NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId") THEN
      RAISE EXCEPTION 'Trading approval is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'trading_versions' THEN
    IF (OLD.status = 'retired' AND NEW.status != 'retired') OR (OLD.status = 'approved' AND NEW.status = 'pending') THEN
      RAISE EXCEPTION 'Invalid algorithm state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'trading_grants' THEN
    IF NEW."usedCny" < OLD."usedCny" OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
      RAISE EXCEPTION 'Grant consumption and revocation cannot be reset' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trading_desks_immutable BEFORE UPDATE ON trading_desks
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE TRIGGER trading_versions_immutable BEFORE UPDATE ON trading_versions
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence('status','approvedAt','approvedByUserId');
CREATE TRIGGER trading_intents_immutable BEFORE UPDATE ON trading_intents
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence('approvedAt','approvedByUserId');
CREATE TRIGGER trading_grants_immutable BEFORE UPDATE ON trading_grants
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence('usedCny','revokedAt');
CREATE TRIGGER trading_executions_immutable BEFORE UPDATE ON trading_executions
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE TRIGGER trading_audit_immutable BEFORE UPDATE ON trading_audit
  FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();

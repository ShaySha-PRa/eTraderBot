CREATE TABLE business_cycles (
 id TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES trading_workspaces(id) ON DELETE CASCADE,
 "requestId" TEXT NOT NULL, name TEXT NOT NULL, start TIMESTAMP(3) NOT NULL, "end" TIMESTAMP(3) NOT NULL,
 rule JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("workspaceId","requestId"), CHECK(start < "end")
);
CREATE TABLE business_evidence (
 id TEXT PRIMARY KEY, "cycleId" TEXT NOT NULL REFERENCES business_cycles(id) ON DELETE CASCADE,
 "recordedByUserId" TEXT NOT NULL, "recordedByBotId" TEXT,
 "streamKey" TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), "supersedesId" TEXT UNIQUE,
 kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('estimated','confirmed')),
 origin TEXT NOT NULL CHECK(origin IN ('synthetic','internal_trial','external_official')),
 source TEXT NOT NULL, "sourceRecordId" TEXT NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "references" JSONB NOT NULL, data JSONB NOT NULL, "contentHash" TEXT NOT NULL,
 UNIQUE("cycleId","streamKey",revision), UNIQUE("cycleId",source,"sourceRecordId")
);
CREATE TABLE business_cycle_analyses (
 "analysisId" TEXT PRIMARY KEY REFERENCES trading_analyses(id) ON DELETE CASCADE,
 "cycleId" TEXT NOT NULL REFERENCES business_cycles(id) ON DELETE CASCADE,
 "evidenceIds" JSONB NOT NULL, "ruleVersion" TEXT NOT NULL
);
CREATE TABLE business_cycle_work (
 "ticketId" TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
 "cycleId" TEXT NOT NULL REFERENCES business_cycles(id) ON DELETE CASCADE,
 "requestId" TEXT NOT NULL, kind TEXT NOT NULL, "dependsOn" JSONB NOT NULL,
 result JSONB, "resultEvidenceId" TEXT, dispatched BOOLEAN NOT NULL DEFAULT false,
 UNIQUE("cycleId","requestId")
);
CREATE TRIGGER business_cycles_immutable BEFORE UPDATE ON business_cycles FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE TRIGGER business_evidence_immutable BEFORE UPDATE ON business_evidence FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
CREATE TRIGGER business_cycle_analyses_immutable BEFORE UPDATE ON business_cycle_analyses FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence();
ALTER TABLE business_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_cycles FORCE ROW LEVEL SECURITY;
CREATE POLICY business_cycle_tenant ON business_cycles
 USING (EXISTS(SELECT 1 FROM trading_workspaces w WHERE w.id="workspaceId"))
 WITH CHECK (EXISTS(SELECT 1 FROM trading_workspaces w WHERE w.id="workspaceId" AND w."ownerUserId"=NULLIF(current_setting('app.user_id',true),'')));
CREATE POLICY business_cycle_system ON business_cycles USING ((SELECT app_rls_bypass()));
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['business_evidence','business_cycle_analyses','business_cycle_work'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY business_child_tenant ON %I USING (EXISTS(SELECT 1 FROM business_cycles c WHERE c.id="cycleId")) WITH CHECK (EXISTS(SELECT 1 FROM business_cycles c JOIN trading_workspaces w ON w.id=c."workspaceId" WHERE c.id="cycleId" AND w."ownerUserId"=NULLIF(current_setting(''app.user_id'',true),'''')))',tbl);
 EXECUTE format('CREATE POLICY business_child_system ON %I USING ((SELECT app_rls_bypass()))',tbl);
 END LOOP;
END $$;

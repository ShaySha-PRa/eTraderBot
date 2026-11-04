CREATE TABLE trading_learning_plans (
 id TEXT PRIMARY KEY, "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "botId" TEXT NOT NULL, "routineId" TEXT NOT NULL UNIQUE REFERENCES routines(id) ON DELETE CASCADE ON UPDATE CASCADE,
 time TEXT NOT NULL, "baselineMargin" TEXT NOT NULL DEFAULT '0',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("deskId", "botId")
);
CREATE TABLE trading_learning_sources (
 id TEXT PRIMARY KEY, "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('chat','file','operation','history')), reference TEXT NOT NULL,
 content TEXT NOT NULL, "contentHash" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("deskId", kind, reference, "contentHash")
);
CREATE INDEX trading_learning_sources_deskId_createdAt_idx ON trading_learning_sources("deskId", "createdAt");
CREATE TABLE trading_learning_sessions (
 id TEXT PRIMARY KEY, "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "botId" TEXT NOT NULL, "runId" TEXT NOT NULL UNIQUE, "inputHash" TEXT NOT NULL, "engineHash" TEXT NOT NULL,
 "baselineMargin" TEXT NOT NULL, sources JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trading_learning_sessions_deskId_createdAt_idx ON trading_learning_sessions("deskId", "createdAt");
CREATE TABLE trading_learning_reports (
 id TEXT PRIMARY KEY, "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "sessionId" TEXT NOT NULL UNIQUE REFERENCES trading_learning_sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 body JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trading_learning_reports_deskId_createdAt_idx ON trading_learning_reports("deskId", "createdAt");
CREATE TABLE trading_learning_requests (
 "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "clientRequestId" TEXT NOT NULL, "botId" TEXT NOT NULL, "runId" TEXT NOT NULL,
 PRIMARY KEY ("deskId", "clientRequestId")
);
DO $$
DECLARE relation_name TEXT;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['trading_learning_plans','trading_learning_sources','trading_learning_sessions','trading_learning_reports','trading_learning_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY trading_learning_tenant ON %I USING (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId")) WITH CHECK (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"))',relation_name);
  EXECUTE format('CREATE POLICY trading_learning_system ON %I USING ((SELECT app_rls_bypass()))',relation_name);
  IF relation_name != 'trading_learning_plans' THEN
   EXECUTE format('CREATE TRIGGER trading_learning_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trading_protect_evidence()',relation_name);
  END IF;
 END LOOP;
END $$;

-- Routine remains the schedule authority, including edits through the general schedule UI.
CREATE FUNCTION trading_learning_routine_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM trading_learning_plans WHERE "routineId" = NEW.id) THEN
  IF cardinality(NEW.crons) != 1 OR NEW.crons[1] !~ '^([0-5]?[0-9]) ([01]?[0-9]|2[0-3]) \* \* \*$'
    OR NEW.prompt IS DISTINCT FROM OLD.prompt OR NEW.watch IS NOT NULL OR NEW."webhookEnabled" OR NEW."githubEnabled" THEN
   RAISE EXCEPTION 'Trading learning requires its fixed prompt and a daily schedule; use learning settings' USING ERRCODE = '23514';
  END IF;
  PERFORM timezone(NEW.timezone, CURRENT_TIMESTAMP);
  UPDATE trading_learning_plans SET time = lpad(split_part(NEW.crons[1], ' ', 2), 2, '0') || ':' || lpad(split_part(NEW.crons[1], ' ', 1), 2, '0')
    WHERE "routineId" = NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trading_learning_schedule_guard AFTER UPDATE ON routines
 FOR EACH ROW EXECUTE FUNCTION trading_learning_routine_guard();

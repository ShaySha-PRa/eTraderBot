-- Additive; legacy associations and tool summaries deliberately remain unrecorded.
ALTER TABLE tasks ADD COLUMN "ticketId" TEXT;
ALTER TABLE tasks ADD CONSTRAINT "tasks_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES tickets(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tasks_ticketId_idx" ON tasks("ticketId");
ALTER TABLE runs ADD COLUMN "toolTraceVersion" INTEGER;
CREATE TABLE run_tool_calls (
  id TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "attemptId" TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "executionId" TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','waiting','completed','failed','refused','ambiguous')),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "run_tool_calls_attemptId_executionId_key" UNIQUE ("attemptId", "executionId")
);
CREATE INDEX "run_tool_calls_spaceId_userId_runId_startedAt_id_idx"
  ON run_tool_calls("spaceId", "userId", "runId", "startedAt", id);
CREATE INDEX "usage_records_spaceId_userId_runId_idx" ON usage_records("spaceId", "userId", "runId");
ALTER TABLE run_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY run_tool_calls_tenant ON run_tool_calls
  USING ("spaceId"=NULLIF(current_setting('app.space_id',true),'')
    AND "userId"=NULLIF(current_setting('app.user_id',true),''));
CREATE POLICY run_tool_calls_system ON run_tool_calls USING ((SELECT app_rls_bypass()));

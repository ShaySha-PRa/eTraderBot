CREATE TABLE "trading_analyses" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "snapshot" JSONB NOT NULL,
  "decision" JSONB NOT NULL,
  "parameters" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trading_analyses_spaceId_userId_createdAt_id_idx"
  ON "trading_analyses"("spaceId", "userId", "createdAt", "id");
ALTER TABLE "trading_analyses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trading_analyses" FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_analyses_tenant ON "trading_analyses"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY trading_analyses_system ON "trading_analyses"
  USING ((SELECT app_rls_bypass()));

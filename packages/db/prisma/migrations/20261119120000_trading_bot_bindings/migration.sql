ALTER TABLE trading_intents ADD COLUMN "botId" TEXT;
ALTER TABLE trading_grants ADD COLUMN "botId" TEXT;
CREATE TABLE trading_bot_bindings (
  "deskId" TEXT NOT NULL REFERENCES trading_desks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE ON UPDATE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('mid_long_term','spot','risk','review')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("deskId","botId")
);
CREATE INDEX trading_bot_bindings_botId_idx ON trading_bot_bindings("botId");
ALTER TABLE trading_bot_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_bot_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY trading_bot_bindings_tenant ON trading_bot_bindings
  USING (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"))
  WITH CHECK (EXISTS (SELECT 1 FROM trading_desks d WHERE d.id = "deskId"));
CREATE POLICY trading_bot_bindings_system ON trading_bot_bindings USING ((SELECT app_rls_bypass()));

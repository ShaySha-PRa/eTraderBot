ALTER TABLE bots ADD COLUMN "tradingRole" TEXT;
ALTER TABLE bots ADD CONSTRAINT bots_trading_role_check
  CHECK ("tradingRole" IS NULL OR "tradingRole" IN ('mid_long_term', 'spot', 'risk', 'review'));

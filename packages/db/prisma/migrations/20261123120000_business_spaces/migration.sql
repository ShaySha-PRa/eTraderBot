BEGIN;
-- Old multi-business containers need an explicit allocation of their chats and encrypted
-- content. Refuse an ambiguous migration rather than move data or rewrite trade evidence.
ALTER TABLE trading_workspaces DISABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM trading_workspaces GROUP BY "spaceId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Multiple legacy business configurations share a Space. Resolve ownership before applying business_spaces; no records have been changed.';
  END IF;
END $$;
CREATE UNIQUE INDEX "trading_workspaces_spaceId_key" ON trading_workspaces("spaceId");
UPDATE spaces s SET name = w.name FROM trading_workspaces w
WHERE w."spaceId" = s.id AND s.name = 'Personal';
ALTER TABLE trading_workspaces ENABLE ROW LEVEL SECURITY;
COMMIT;

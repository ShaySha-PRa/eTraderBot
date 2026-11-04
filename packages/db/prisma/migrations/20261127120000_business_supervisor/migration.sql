BEGIN;
ALTER TABLE bots ADD COLUMN "businessSupervisor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bots ADD CONSTRAINT business_supervisor_role CHECK (NOT "businessSupervisor" OR "tradingRole" IS NULL);
CREATE UNIQUE INDEX bots_one_business_supervisor ON bots("spaceId") WHERE "businessSupervisor";
CREATE OR REPLACE FUNCTION enforce_bot_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_kind text; pending boolean;
BEGIN
 SELECT kind, "isolationPending" INTO target_kind, pending FROM spaces WHERE id=NEW."spaceId" FOR SHARE;
 IF pending OR (target_kind='general') <> (NEW."tradingRole" IS NULL AND NOT NEW."businessSupervisor") THEN
  RAISE EXCEPTION 'Bot role does not match an active workspace';
 END IF;
 IF TG_OP='UPDATE' AND (OLD."tradingRole" IS DISTINCT FROM NEW."tradingRole" OR OLD."businessSupervisor" IS DISTINCT FROM NEW."businessSupervisor") THEN
  RAISE EXCEPTION 'Bot role is immutable';
 END IF;
 IF NEW."businessSupervisor" AND NOT EXISTS(SELECT 1 FROM trading_workspaces w WHERE w."spaceId"=NEW."spaceId" AND w."ownerUserId"=NEW."userId") THEN
  RAISE EXCEPTION 'Supervisor must belong to the business owner';
 END IF;
 IF NEW."computerId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM computers c WHERE c.id=NEW."computerId" AND c."spaceId"=NEW."spaceId" AND c."userId"=NEW."userId"
 ) THEN RAISE EXCEPTION 'Computer belongs to another workspace'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER bot_workspace_kind ON bots;
CREATE TRIGGER bot_workspace_kind BEFORE INSERT OR UPDATE OF "spaceId", "userId", "tradingRole", "businessSupervisor", "computerId" ON bots
 FOR EACH ROW EXECUTE FUNCTION enforce_bot_workspace_kind();
CREATE OR REPLACE FUNCTION enforce_workspace_kind_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.kind<>NEW.kind AND (EXISTS(SELECT 1 FROM bots WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_workspaces WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_desks WHERE "spaceId"=NEW.id) OR EXISTS(SELECT 1 FROM trading_analyses WHERE "spaceId"=NEW.id)) THEN
  RAISE EXCEPTION 'A workspace with existing content cannot change kind';
 END IF;
 IF NOT NEW."isolationPending" AND EXISTS(SELECT 1 FROM bots b WHERE b."spaceId"=NEW.id AND (NEW.kind='general') <> (b."tradingRole" IS NULL AND NOT b."businessSupervisor")) THEN
  RAISE EXCEPTION 'Resolve legacy Bot ownership before activating this workspace';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION protect_business_supervisor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."businessSupervisor" AND EXISTS(SELECT 1 FROM spaces WHERE id=OLD."spaceId" AND "deletingAt" IS NULL)
 AND (TG_OP='DELETE' OR NEW."archivedAt" IS NOT NULL OR NEW."spaceId"<>OLD."spaceId" OR NEW."userId"<>OLD."userId") THEN
  RAISE EXCEPTION 'The business supervisor stays with its workspace';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_supervisor_lifecycle BEFORE DELETE OR UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION protect_business_supervisor();
COMMIT;

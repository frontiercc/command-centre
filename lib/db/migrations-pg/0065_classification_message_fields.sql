-- Each classification carries its prompt's time, session, person, surface and source, so Work Pulse
-- reads classifications alone instead of joining every one to cowork_messages (the largest table).
-- Two triggers keep the copies equal to the message whoever writes either table: the classifier,
-- seeders, tests, or a demo reseed that moves message times. pulse_classifications is small, so the
-- backfill is quick; the trigger on cowork_messages fires only when one of the copied columns changes.
ALTER TABLE "pulse_classifications"
  ADD COLUMN IF NOT EXISTS "msg_occurred_at" bigint,
  ADD COLUMN IF NOT EXISTS "msg_session_id" text,
  ADD COLUMN IF NOT EXISTS "msg_user_id" text,
  ADD COLUMN IF NOT EXISTS "msg_surface" text,
  ADD COLUMN IF NOT EXISTS "msg_source" text;
--> statement-breakpoint
UPDATE "pulse_classifications" pc
   SET "msg_occurred_at" = cm."occurred_at", "msg_session_id" = cm."session_id", "msg_user_id" = cm."user_id",
       "msg_surface" = cm."surface", "msg_source" = cm."source"
  FROM "cowork_messages" cm
 WHERE cm."id" = pc."cowork_message_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_class_msg_occurred_at" ON "pulse_classifications" ("msg_occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_class_msg_session" ON "pulse_classifications" ("msg_session_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pulse_classifications_fill_msg"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT cm."occurred_at", cm."session_id", cm."user_id", cm."surface", cm."source"
    INTO NEW."msg_occurred_at", NEW."msg_session_id", NEW."msg_user_id", NEW."msg_surface", NEW."msg_source"
    FROM "cowork_messages" cm WHERE cm."id" = NEW."cowork_message_id";
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pulse_classifications_fill_msg" ON "pulse_classifications";
--> statement-breakpoint
CREATE TRIGGER "pulse_classifications_fill_msg" BEFORE INSERT OR UPDATE OF "cowork_message_id" ON "pulse_classifications"
  FOR EACH ROW EXECUTE FUNCTION "pulse_classifications_fill_msg"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "cowork_messages_sync_classification"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "pulse_classifications"
     SET "msg_occurred_at" = NEW."occurred_at", "msg_session_id" = NEW."session_id", "msg_user_id" = NEW."user_id",
         "msg_surface" = NEW."surface", "msg_source" = NEW."source"
   WHERE "cowork_message_id" = NEW."id";
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cowork_messages_sync_classification" ON "cowork_messages";
--> statement-breakpoint
CREATE TRIGGER "cowork_messages_sync_classification"
  AFTER UPDATE OF "occurred_at", "session_id", "user_id", "surface", "source" ON "cowork_messages"
  FOR EACH ROW
  WHEN (OLD."occurred_at" IS DISTINCT FROM NEW."occurred_at" OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
     OR OLD."user_id" IS DISTINCT FROM NEW."user_id" OR OLD."surface" IS DISTINCT FROM NEW."surface"
     OR OLD."source" IS DISTINCT FROM NEW."source")
  EXECUTE FUNCTION "cowork_messages_sync_classification"();

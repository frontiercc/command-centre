CREATE TABLE IF NOT EXISTS "chat_assistant_meta" (
  "id" text PRIMARY KEY,
  "conversation_id" text,
  "user_id" text REFERENCES "users"("id"),
  "model" text,
  "artifacts_count" integer DEFAULT 0 NOT NULL,
  "generated_files_count" integer DEFAULT 0 NOT NULL,
  "occurred_at" bigint NOT NULL,
  "ingested_at" bigint DEFAULT extract(epoch from now())
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_am_conversation" ON "chat_assistant_meta" ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_am_user" ON "chat_assistant_meta" ("user_id","occurred_at");

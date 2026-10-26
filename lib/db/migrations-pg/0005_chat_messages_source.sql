ALTER TABLE "chat_messages" ADD COLUMN "source" text NOT NULL DEFAULT 'agent';--> statement-breakpoint
UPDATE "chat_messages" SET "source" = CASE
  WHEN "agent_id" IS NOT NULL THEN 'agent'
  WHEN "conversation_id" LIKE 'claude_chat_%' THEN 'compliance'
  ELSE 'agent' END;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_source" ON "chat_messages" ("source");

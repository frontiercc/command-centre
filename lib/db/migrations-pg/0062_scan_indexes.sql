-- Indexes for reads that searched whole tables.
-- The newest Claude Code metric point (System health, Developer Pulse data health): without an index
-- on its time, finding it read every metric point.
CREATE INDEX IF NOT EXISTS "idx_com_occurred_at" ON "code_otel_metrics" ("occurred_at");
--> statement-breakpoint
-- The newest row from one source (when ChatGPT or Codex last sent anything): with only an index on
-- arrival time, a hub where that source never sent anything read the whole index to find none.
CREATE INDEX IF NOT EXISTS "idx_cowork_messages_source_ingested" ON "cowork_messages" ("source", "ingested_at");
--> statement-breakpoint
-- The Audit Log's list: newest first, leaving out model calls and tool calls, which are most of the
-- table. Without it, each page stepped through every left-out row to find the next prompt.
CREATE INDEX IF NOT EXISTS "idx_cowork_messages_audit" ON "cowork_messages" ("occurred_at")
  WHERE message_type NOT IN ('cowork_tool_summary', 'cowork_message', 'cowork_session_init', 'cowork_tool_metadata', 'cowork_api_request', 'cowork_api_error');

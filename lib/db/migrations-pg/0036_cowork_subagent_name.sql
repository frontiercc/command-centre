-- Claude subagents. Cowork model calls and subagent launches keep the
-- subagent's name (OTel `agent.name` on api_request; `subagent_type` from the
-- Agent tool's parameters) and the request's `query_source`, as Claude Code
-- rows already do on code_assistant_meta. Forward-only: earlier rows stay NULL.
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS agent_name text;
--> statement-breakpoint
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS query_source text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cowork_messages_agent_name ON cowork_messages (agent_name, occurred_at) WHERE agent_name IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cam_agent_name ON code_assistant_meta (agent_name, occurred_at) WHERE agent_name IS NOT NULL;

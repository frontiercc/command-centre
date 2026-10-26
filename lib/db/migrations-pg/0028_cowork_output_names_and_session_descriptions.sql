-- Work Pulse frontier boxes.
--
-- output_name: the FILE NAME (never the directory, never the content) of an
-- output tool call (Write / SendUserFile / Artifact), read from the tool
-- parameters the client already sends with OTEL_LOG_TOOL_DETAILS=1 and passed
-- through the PII scrub. Content-derived: retention's strip mode nulls it.
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS output_name TEXT;
--> statement-breakpoint
-- One cached, model-written sentence describing what a session's work was,
-- written from its scrubbed prompts by a background job, only for sessions the
-- frontier boxes can show. description NULL = a failed attempt (retried up to
-- the attempt cap). occurred_at = the session's latest prompt, so retention can
-- delete a description with the content it was written from.
CREATE TABLE IF NOT EXISTS cowork_session_descriptions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  occurred_at BIGINT NOT NULL,
  generated_at BIGINT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cowork_session_descriptions_user ON cowork_session_descriptions (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cowork_session_descriptions_occurred ON cowork_session_descriptions (occurred_at);

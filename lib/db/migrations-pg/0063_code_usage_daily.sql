-- Claude Code model calls added up per session, UTC day and model (with the subagent, skill,
-- effort and query source of each call), kept current by the scheduled job code_usage_daily
-- (lib/pulse/code/usage-daily.ts). Pages read these instead of adding up every model call on each
-- visit. Text columns use '' for "none", so they can be part of the key.
-- Prompt counts: each (prompt, model) pair is counted once, in the row of its first call with that
-- model (model_prompts); likewise (prompt, skill, model) and (prompt, subagent, model), so summing
-- a column over any set of rows gives distinct prompts for that grouping.
CREATE TABLE IF NOT EXISTS "code_usage_daily" (
  "session_id" text NOT NULL,
  "day_start" bigint NOT NULL,
  "user_id" text NOT NULL DEFAULT '',
  "model" text NOT NULL DEFAULT '',
  "agent_name" text NOT NULL DEFAULT '',
  "skill_name" text NOT NULL DEFAULT '',
  "effort" text NOT NULL DEFAULT '',
  "query_source" text NOT NULL DEFAULT '',
  "source" text NOT NULL DEFAULT '',
  "calls" integer NOT NULL DEFAULT 0,
  "model_prompts" integer NOT NULL DEFAULT 0,
  "skill_prompts" integer NOT NULL DEFAULT 0,
  "agent_prompts" integer NOT NULL DEFAULT 0,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "cache_creation_tokens" bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "commit_count" bigint NOT NULL DEFAULT 0,
  "error_count" bigint NOT NULL DEFAULT 0,
  "tool_use_count" bigint NOT NULL DEFAULT 0,
  "first_at" bigint NOT NULL,
  "last_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "day_start", "user_id", "model", "agent_name", "skill_name", "effort", "query_source", "source")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cud_day" ON "code_usage_daily" ("day_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cud_user_day" ON "code_usage_daily" ("user_id", "day_start");

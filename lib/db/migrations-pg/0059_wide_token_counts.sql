-- Token totals as 64-bit integers, so a long-lived session's totals always fit
-- (a 32-bit column holds up to 2,147,483,647). Covers Claude Code sessions,
-- Cowork sessions and the per-scope Code totals. All three tables are small,
-- so the rewrite takes seconds.
ALTER TABLE code_session_stats
  ALTER COLUMN input_tokens TYPE bigint,
  ALTER COLUMN output_tokens TYPE bigint,
  ALTER COLUMN cache_creation_tokens TYPE bigint,
  ALTER COLUMN cache_read_tokens TYPE bigint;--> statement-breakpoint
ALTER TABLE code_metrics
  ALTER COLUMN input_tokens TYPE bigint,
  ALTER COLUMN output_tokens TYPE bigint;--> statement-breakpoint
ALTER TABLE cowork_session_stats
  ALTER COLUMN total_input_tokens TYPE bigint,
  ALTER COLUMN total_output_tokens TYPE bigint,
  ALTER COLUMN total_cache_read_tokens TYPE bigint,
  ALTER COLUMN total_cache_creation_tokens TYPE bigint;--> statement-breakpoint
-- The hourly roll-up finds changed sessions with "ingested_at >= last run";
-- this index serves that query.
CREATE INDEX IF NOT EXISTS idx_cam_ingested_at ON code_assistant_meta (ingested_at);

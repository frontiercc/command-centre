-- Token totals as 64-bit integers. One long-lived Claude Code session can pass
-- 2,147,483,647 cache-read tokens; the insert into code_session_stats then
-- failed ("out of range for type integer") and stopped the hourly Developer
-- Pulse roll-up part-way through. The Cowork session totals and the per-scope
-- Code totals have the same limit. All three tables are small, so the rewrite
-- takes seconds.
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
-- The hourly roll-up finds changed sessions with "ingested_at >= last run".
-- With no index on that column it scanned all of code_assistant_meta each run.
CREATE INDEX IF NOT EXISTS idx_cam_ingested_at ON code_assistant_meta (ingested_at);

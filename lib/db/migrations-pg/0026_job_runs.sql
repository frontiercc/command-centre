CREATE TABLE IF NOT EXISTS job_runs (
  job_name TEXT PRIMARY KEY,
  last_started_at BIGINT,
  last_succeeded_at BIGINT,
  last_failed_at BIGINT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER
);

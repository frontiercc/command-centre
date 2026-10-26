-- 0020_session_output.sql — Postgres twin of 079_session_output.sql.
ALTER TABLE cowork_session_stats ADD COLUMN IF NOT EXISTS produced_output INTEGER;

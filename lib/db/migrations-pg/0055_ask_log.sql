-- Ask the data (admin only): one row per question an admin asked. It keeps the question, the
-- page it was asked from, which lookups ran (names and inputs), the outcome and the measured
-- cost, so an admin can see what it is used for, what it could not answer and what it costs.
-- The answer text is never stored (the app stores no AI replies). asked_by is the admin session
-- email. Rows older than the admin's retention setting (ask_log_retention_days, default 90) are
-- deleted when a new question is logged.
CREATE TABLE IF NOT EXISTS "ask_log" (
  "id" text PRIMARY KEY NOT NULL,
  "asked_at" bigint NOT NULL,
  "asked_by" text NOT NULL,
  "question" text NOT NULL,
  "page" text,
  -- JSON array of {name, input} for each lookup the model ran.
  "lookups_json" text NOT NULL,
  -- answered | not_answerable | refused | capped | error
  "outcome" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  -- USD at list price from the token counts Anthropic returned; null when the model is unpriced.
  "cost_usd" numeric,
  "duration_ms" integer
);
CREATE INDEX IF NOT EXISTS "idx_ask_log_asked_at" ON "ask_log" ("asked_at");

-- Cowork (and Claude in Office and Google) model calls added up per session, UTC day and model,
-- kept current by the scheduled job cowork_usage_daily (lib/pulse/cowork/usage-daily.ts). Pages
-- read these instead of adding up every Cowork model call on each visit. Text columns use '' for
-- "none", so they can be part of the key.
CREATE TABLE IF NOT EXISTS "cowork_usage_daily" (
  "session_id" text NOT NULL,
  "day_start" bigint NOT NULL,
  "user_id" text NOT NULL DEFAULT '',
  "model" text NOT NULL DEFAULT '',
  "agent_name" text NOT NULL DEFAULT '',
  "skill_name" text NOT NULL DEFAULT '',
  "query_source" text NOT NULL DEFAULT '',
  "product" text NOT NULL DEFAULT '',
  "surface" text NOT NULL DEFAULT '',
  "source" text NOT NULL DEFAULT '',
  "calls" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric,
  "costed" integer NOT NULL DEFAULT 0,
  "with_usage" integer NOT NULL DEFAULT 0,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "cache_creation_tokens" bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "first_at" bigint NOT NULL,
  "last_at" bigint NOT NULL,
  PRIMARY KEY ("session_id", "day_start", "user_id", "model", "agent_name", "skill_name", "query_source", "product", "surface", "source")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wud_day" ON "cowork_usage_daily" ("day_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wud_user_day" ON "cowork_usage_daily" ("user_id", "day_start");

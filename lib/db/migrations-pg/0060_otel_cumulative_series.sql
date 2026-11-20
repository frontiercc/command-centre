-- The last running total seen for each Claude Code metric series sent with cumulative temporality,
-- so the receiver can store the increase since the last report (lib/otel/code-metrics-receiver.ts).
-- A series is one metric for one person, session, sub-type, model and language. Short-lived: rows
-- not updated for seven days are deleted by retention, and a person's rows go with them on erasure.
CREATE TABLE IF NOT EXISTS "otel_cumulative_series" (
	"series_key" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"start_time" bigint,
	"last_time" bigint NOT NULL,
	"value" double precision NOT NULL,
	"updated_at" bigint NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otel_cumulative_series_updated" ON "otel_cumulative_series" ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otel_cumulative_series_user" ON "otel_cumulative_series" ("user_id");

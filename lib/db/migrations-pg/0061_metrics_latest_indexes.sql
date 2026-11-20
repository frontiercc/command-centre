-- Indexes for reading a scope's newest score snapshot, or the newest one before a date, and Claude
-- Code model calls by date. The hourly
-- jobs add a snapshot per scope each run and keep a month of them, because week-over-week
-- comparisons and weekly averages read older ones; without these, every "latest" read searched all
-- of a scope's snapshots.
CREATE INDEX IF NOT EXISTS "idx_pulse_metrics_latest" ON "pulse_metrics" ("scope_type", "scope_id", "granularity", "computed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_metrics_vendor_latest" ON "pulse_metrics_vendor" ("vendor", "scope_type", "scope_id", "granularity", "computed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_code_metrics_latest" ON "code_metrics" ("scope_type", "scope_id", "granularity", "computed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_code_metrics_vendor_latest" ON "code_metrics_vendor" ("vendor", "scope_type", "scope_id", "granularity", "computed_at");
--> statement-breakpoint
-- Claude Code model calls by date: FinOps and Model Efficiency read one month of them, which without
-- this index meant reading the whole table on every visit.
CREATE INDEX IF NOT EXISTS "idx_cam_occurred_at" ON "code_assistant_meta" ("occurred_at");
--> statement-breakpoint
-- Prompts by date with the columns the dashboard's daily counts read, so those counts read the
-- index alone instead of the whole prompt rows.
CREATE INDEX IF NOT EXISTS "idx_cowork_messages_day_counts" ON "cowork_messages" ("occurred_at") INCLUDE ("user_id", "source", "surface", "session_id");

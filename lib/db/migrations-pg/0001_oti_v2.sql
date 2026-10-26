-- OTI v2. metric_version distinguishes OTI-formula
-- generations; oti_early_read flags a still-forming baseline; oti_active_days
-- records current-window active days (per-user scope).
ALTER TABLE "pulse_metrics" ADD COLUMN "metric_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pulse_metrics" ADD COLUMN "oti_early_read" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pulse_metrics" ADD COLUMN "oti_active_days" integer;

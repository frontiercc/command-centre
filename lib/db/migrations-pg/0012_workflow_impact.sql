ALTER TABLE "use_case_activation_weeks" ADD COLUMN "measured_duration_secs" integer;--> statement-breakpoint
ALTER TABLE "use_case_activation_weeks" ADD COLUMN "engaged_secs" integer;--> statement-breakpoint
ALTER TABLE "use_case_activation_weeks" ADD COLUMN "tool_error_count" integer;--> statement-breakpoint
ALTER TABLE "use_case_activation_weeks" ADD COLUMN "edit_reject_count" integer;--> statement-breakpoint
ALTER TABLE "use_case_activation_weeks" ADD COLUMN "edit_accept_count" integer;--> statement-breakpoint
ALTER TABLE "use_case_activation_weeks" ADD COLUMN "flagged_count" integer;--> statement-breakpoint
ALTER TABLE "use_cases" ADD COLUMN "impact_summary" text;--> statement-breakpoint
ALTER TABLE "use_cases" ADD COLUMN "impact_summary_at" bigint;

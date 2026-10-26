ALTER TABLE "use_case_activation_weeks" ADD COLUMN "cowork_tool_error_count" integer;--> statement-breakpoint
UPDATE "use_cases" SET "impact_summary" = NULL, "impact_summary_at" = NULL;

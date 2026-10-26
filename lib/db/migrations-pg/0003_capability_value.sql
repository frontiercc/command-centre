-- Capability value attribution. All nullable.
ALTER TABLE "pulse_events" ADD COLUMN "value_type" text;--> statement-breakpoint
ALTER TABLE "pulse_events" ADD COLUMN "value_amount" double precision;--> statement-breakpoint
ALTER TABLE "pulse_events" ADD COLUMN "value_period" text;--> statement-breakpoint
ALTER TABLE "pulse_events" ADD COLUMN "value_basis" text;--> statement-breakpoint
ALTER TABLE "pulse_events" ADD COLUMN "attributed_by" text;--> statement-breakpoint
ALTER TABLE "pulse_events" ADD COLUMN "attributed_at" bigint;

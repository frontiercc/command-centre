-- Department sync from Microsoft Entra ID (1.3.0). Where each person's
-- department came from and when the directory last confirmed it, on both
-- login accounts (admin_users) and monitored people (users), plus a record of
-- every department change. department_source: 'directory' (set by the sync),
-- 'manual' (set by an admin, which the sync never overrides) or NULL (set any
-- other way: telemetry, import, or before this migration).
ALTER TABLE "admin_users" ADD COLUMN "department_source" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "department_synced_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department_synced_at" bigint;--> statement-breakpoint
-- One row per department change. user_id is the monitored person (users.id),
-- admin_user_id the login account; either may be NULL when the person has
-- only one of the two. is_move = 1 marks a move from one real department to
-- another made by the directory after that person's first directory sync:
-- FinOps splits an open month's spend at changed_at for those rows only.
-- Deleted with the person (deleteUserData by user_id, deleteAdminUser by
-- admin_user_id).
CREATE TABLE "department_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"admin_user_id" text,
	"from_department" text,
	"to_department" text,
	"source" text NOT NULL,
	"is_move" integer DEFAULT 0 NOT NULL,
	"changed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_department_history_user" ON "department_history" USING btree ("user_id","changed_at");--> statement-breakpoint
CREATE INDEX "idx_department_history_admin_user" ON "department_history" USING btree ("admin_user_id","changed_at");

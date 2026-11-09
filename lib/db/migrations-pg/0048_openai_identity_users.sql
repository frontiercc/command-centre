-- Which person each OpenAI account (the export's actor.user_id) resolved to,
-- so the OpenAI sync can tell when one OpenAI account arrives under a second,
-- different email. That is recorded in otel_identity_conflicts, the same
-- table and admin Merge / Keep separate as a Claude installation shared by
-- two accounts; product says which ('claude' or 'openai'). Deleted with the
-- person by deleteUserData (user_id).
CREATE TABLE "openai_identity_users" (
	"openai_user_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_openai_identity_users_user" ON "openai_identity_users" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "otel_identity_conflicts" ADD COLUMN "product" text DEFAULT 'claude' NOT NULL;

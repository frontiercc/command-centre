CREATE TABLE IF NOT EXISTS "github_user_repo_stats" (
  "user_id" text NOT NULL,
  "repo" text NOT NULL,
  "date" text NOT NULL,
  "commit_count" integer DEFAULT 0 NOT NULL,
  "synced_at" bigint NOT NULL,
  PRIMARY KEY ("user_id","repo","date")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gurs_repo_date" ON "github_user_repo_stats" ("repo","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gurs_user_date" ON "github_user_repo_stats" ("user_id","date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_identity_map" (
  "identity" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "created_at" bigint DEFAULT extract(epoch from now()) NOT NULL,
  "created_by" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_unmatched_authors" (
  "identity" text PRIMARY KEY,
  "commit_count" integer DEFAULT 0 NOT NULL,
  "last_synced" bigint NOT NULL
);

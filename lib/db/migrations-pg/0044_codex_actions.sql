-- Codex actions from the Codex log (TOOL_CALL_COMPLETED / TOOL_CALL_FAILED):
-- one row per tool call, with whether it failed and whether it was a
-- `git commit`, for Developer Pulse's Automation, Shipping and friction
-- figures. Counts only: the command or input is read to spot a commit and
-- never stored. Kept apart from code_assistant_meta so no Claude Code figure
-- counts a Codex action.
CREATE TABLE "codex_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tool_name" text,
	"failed" integer DEFAULT 0 NOT NULL,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"occurred_at" bigint NOT NULL,
	"ingested_at" bigint DEFAULT extract(epoch from now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_codex_actions_session" ON "codex_actions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_codex_actions_user_time" ON "codex_actions" USING btree ("user_id","occurred_at");

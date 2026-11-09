-- GitHub commits split by the AI tool that made them, without reading any
-- commit message. The GitHub sync matches each commit, in memory, to a commit
-- the same person recorded through Claude Code (the claude_code.commit.count
-- metric, else code_assistant_meta.commit_count) or Codex (codex_actions)
-- within 15 minutes of the commit's author time; each tool commit matches at
-- most one GitHub commit. Only the three counts are stored, per repo per day
-- and per person per repo per day; they add up to commit_count, which is
-- unchanged. NULL = a row synced before this split existed (total only).
ALTER TABLE "github_repo_stats" ADD COLUMN "claude_commit_count" integer;--> statement-breakpoint
ALTER TABLE "github_repo_stats" ADD COLUMN "codex_commit_count" integer;--> statement-breakpoint
ALTER TABLE "github_repo_stats" ADD COLUMN "no_tool_commit_count" integer;--> statement-breakpoint
ALTER TABLE "github_user_repo_stats" ADD COLUMN "claude_commit_count" integer;--> statement-breakpoint
ALTER TABLE "github_user_repo_stats" ADD COLUMN "codex_commit_count" integer;--> statement-breakpoint
ALTER TABLE "github_user_repo_stats" ADD COLUMN "no_tool_commit_count" integer;

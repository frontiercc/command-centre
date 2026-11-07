-- Working time and by-hand estimates for ChatGPT conversations (OpenAI
-- export), for Work Pulse's "By hand vs with AI" card. Kept apart from
-- cowork_session_stats, which Claude Cowork's telemetry fills and many other
-- figures read, so adding ChatGPT changes human time and nothing else.
-- active_secs is measured from the times of the person's prompts and
-- ChatGPT's replies (gaps up to 30 minutes, as for Claude Cowork).
CREATE TABLE "chatgpt_session_time" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"first_at" bigint NOT NULL,
	"last_at" bigint NOT NULL,
	"active_secs" integer DEFAULT 0 NOT NULL,
	"human_minutes_low" integer,
	"human_minutes_likely" integer,
	"human_minutes_high" integer,
	"human_minutes_attempts" integer DEFAULT 0 NOT NULL,
	"computed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_chatgpt_session_time_user" ON "chatgpt_session_time" USING btree ("user_id","first_at");--> statement-breakpoint
CREATE INDEX "idx_chatgpt_session_time_first" ON "chatgpt_session_time" USING btree ("first_at");

-- ChatGPT and Codex spend from the OpenAI export, kept apart from Claude's
-- spend so no page shows OpenAI money under a Claude label. Each page reads
-- these tables when it gets its Claude / OpenAI split.
--
-- openai_costs: one COSTS record each: a person's cost for one model, product
-- and app in one UTC hour. cost_usd is the billed dollar amount, or OpenAI's
-- estimated dollar value when the workspace is billed in credits.
CREATE TABLE "openai_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"agent_name" text,
	"hour_start" bigint NOT NULL,
	"product" text NOT NULL,
	"client" text,
	"model" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric,
	"credits" numeric,
	"billed_in" text NOT NULL,
	"ingested_at" bigint DEFAULT extract(epoch from now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_openai_costs_hour" ON "openai_costs" USING btree ("product","hour_start");--> statement-breakpoint
CREATE INDEX "idx_openai_costs_user_hour" ON "openai_costs" USING btree ("user_id","hour_start");--> statement-breakpoint
-- openai_replies: a ChatGPT reply's model and time, never its text. Used to
-- share each hourly cost across that hour's conversations.
CREATE TABLE "openai_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"occurred_at" bigint NOT NULL,
	"ingested_at" bigint DEFAULT extract(epoch from now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_openai_replies_user_time" ON "openai_replies" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_openai_replies_session" ON "openai_replies" USING btree ("session_id");--> statement-breakpoint
-- codex_turns: one CODEX_TURN record each. Tokens are priced from the rates
-- table; openai_cost_usd is OpenAI's own estimate, kept for comparison.
CREATE TABLE "codex_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"model" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"uncached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"credits" numeric,
	"openai_cost_usd" numeric,
	"automation" integer DEFAULT 0 NOT NULL,
	"ingested_at" bigint DEFAULT extract(epoch from now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_codex_turns_user_time" ON "codex_turns" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_codex_turns_session" ON "codex_turns" USING btree ("session_id");

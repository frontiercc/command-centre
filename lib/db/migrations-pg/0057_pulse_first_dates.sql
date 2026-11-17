-- Each person's first Work Pulse prompt the classifier judged, or first Developer Pulse session,
-- and the first one judged meaningful or better: what So What's "waves" are measured from.
-- Retention deletes the prompts and sessions those dates are read from, so once a hub was older
-- than its retention window everyone who started earlier looked as if they had started in the
-- oldest month kept. Retention now copies the dates in here before it deletes (lib/pulse/first-dates.ts).
-- Dates only, no content; deleted with the person on erasure.
-- surface: 'work' (Work Pulse) or 'code' (Developer Pulse). vendor: 'claude' or 'openai'.
CREATE TABLE IF NOT EXISTS "pulse_first_dates" (
  "surface" text NOT NULL,
  "user_id" text NOT NULL,
  "vendor" text NOT NULL,
  "first_at" bigint NOT NULL,
  "first_deep_at" bigint,
  PRIMARY KEY ("surface", "user_id", "vendor")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pulse_first_dates_user" ON "pulse_first_dates" ("user_id");
--> statement-breakpoint
-- From when the dates are complete. Retention has already deleted anything older than its window
-- (each window at least 7 days, 90 unless changed), so a wave starting before then cannot be
-- measured and So What leaves it out rather than show it wrong. Work Pulse reads Cowork and Chat,
-- so it takes the shorter of their two windows.
INSERT INTO "config" ("key", "value", "updated_at")
SELECT 'pulse_first_dates_work_from',
       (extract(epoch from now())::bigint - LEAST(
          GREATEST(7, COALESCE((SELECT NULLIF(value, '')::int FROM "config" WHERE "key" = 'retention_cowork_days'), 90)),
          GREATEST(7, COALESCE((SELECT NULLIF(value, '')::int FROM "config" WHERE "key" = 'retention_chat_days'), 90))
        ) * 86400)::text,
       extract(epoch from now())::bigint
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "config" ("key", "value", "updated_at")
SELECT 'pulse_first_dates_code_from',
       (extract(epoch from now())::bigint
        - GREATEST(7, COALESCE((SELECT NULLIF(value, '')::int FROM "config" WHERE "key" = 'retention_code_days'), 90)) * 86400)::text,
       extract(epoch from now())::bigint
ON CONFLICT ("key") DO NOTHING;

-- So What's "used it once and hardly since" asks, for each person, whether they have ever sent a
-- Work Pulse prompt. Without these it read every prompt ever stored on every build, which on a
-- hub with years of history took many seconds. With them it is one index look-up per person.
-- One index per vendor, because Claude and ChatGPT prompts both carry a source, so the vendor
-- views (Claude, OpenAI) each look up their own. The conditions match lib/pulse/work-surfaces.ts
-- (Work Pulse surfaces) and lib/openai/sources.ts (OpenAI sources) exactly; if either list
-- changes, the query is still right but no longer uses the index, and a test says so.
CREATE INDEX IF NOT EXISTS idx_cowork_wp_people_claude ON cowork_messages (user_id)
  WHERE message_type = 'cowork_user_message' AND (surface IN ('cowork', 'chat') OR surface IS NULL)
    AND (source IS NULL OR source NOT IN ('chatgpt_chat', 'chatgpt_work', 'codex'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cowork_wp_people_openai ON cowork_messages (user_id)
  WHERE message_type = 'cowork_user_message' AND (surface IN ('cowork', 'chat') OR surface IS NULL)
    AND source IN ('chatgpt_chat', 'chatgpt_work', 'codex');

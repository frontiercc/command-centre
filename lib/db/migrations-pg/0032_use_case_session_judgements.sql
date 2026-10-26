-- Use cases defined by the work.
--
-- One row per judged Cowork or Code session: which live use cases the session
-- was an instance of (judged by a model reading the session's prompts, or by
-- the session running a use case's own codified skill), a short model-written
-- reason, and what is needed to know when to judge it again: the session's
-- last event when judged (newer activity means judge again) and a key over the
-- use cases it was judged against (a confirmed, edited or archived use case
-- changes the key). use_case_ids / skill_matched_ids are JSON arrays of
-- use_cases.id. reason is about prompt content, so retention deletes the row
-- on the content window and erasure deletes it by user.
CREATE TABLE IF NOT EXISTS use_case_session_judgements (
  session_id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  user_id TEXT NOT NULL,
  department TEXT,
  use_case_ids TEXT NOT NULL DEFAULT '[]',
  skill_matched_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  candidate_key TEXT NOT NULL,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  first_event_at BIGINT NOT NULL,
  last_event_at BIGINT NOT NULL,
  model TEXT,
  judged_at BIGINT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_use_case_session_judgements_user ON use_case_session_judgements (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_use_case_session_judgements_last_event ON use_case_session_judgements (last_event_at);

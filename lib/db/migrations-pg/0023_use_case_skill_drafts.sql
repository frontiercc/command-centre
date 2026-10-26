CREATE TABLE IF NOT EXISTS use_case_skill_drafts (
  use_case_id TEXT PRIMARY KEY REFERENCES use_cases(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  description TEXT NOT NULL,
  body_md TEXT NOT NULL,
  owner_questions_json TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  corpus_stats_json TEXT NOT NULL,
  thin INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  generated_at BIGINT NOT NULL,
  edited_at BIGINT,
  downloaded_at BIGINT,
  library_entry_id INTEGER REFERENCES skill_library_entries(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_use_case_skill_drafts_skill_name ON use_case_skill_drafts(skill_name);

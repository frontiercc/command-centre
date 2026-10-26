-- Cowork model calls keep the skill that was running (OTel
-- `skill.name` on api_request), as Claude Code calls already do on
-- code_assistant_meta. Feeds "where the money went" by skill in the Audit Log
-- and Spend Review. Forward-only: earlier rows stay NULL.
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS skill_name text;

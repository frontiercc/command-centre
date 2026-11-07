-- Claude Chat prompts move into cowork_messages, beside Cowork and ChatGPT
-- prompts, so Work Pulse classifies them like every other prompt. Each row
-- keeps its id, person, text, flags, times and source ('compliance' or the
-- retired local agent's 'agent'), with surface 'chat' and one cowork_sessions
-- row per conversation. chat_assistant_meta (reply metadata) is unchanged.
--
-- The migrator runs this in one transaction: either every prompt moves and
-- chat_messages is dropped, or nothing changes.

-- A prompt whose id is already taken in cowork_messages (never seen; ids come
-- from different systems) keeps its text under a prefixed id rather than
-- being lost when chat_messages goes.
INSERT INTO cowork_messages (
  id, session_id, user_id, message_type, surface, source,
  content_preview, content_full, flagged, flag_reason,
  occurred_at, ingested_at, agent_id
)
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM cowork_messages c WHERE c.id = m.id)
       THEN 'claude-chat:' || m.id ELSE m.id END,
  COALESCE(m.conversation_id, ''),
  m.user_id,
  'cowork_user_message',
  'chat',
  m.source,
  -- A retention-stripped prompt holds only the marker: kept as the preview,
  -- with no full text, the same shape retention gives a stripped Cowork prompt.
  left(m.prompt_text, 250),
  CASE WHEN m.prompt_text = '[Content removed — retention policy]' THEN NULL ELSE m.prompt_text END,
  COALESCE(m.flagged, 0),
  m.flag_reason,
  m.occurred_at,
  m.ingested_at,
  m.agent_id
FROM chat_messages m;
--> statement-breakpoint

-- One session per conversation, started at its first prompt.
INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at, created_at)
SELECT
  m.conversation_id,
  m.conversation_id,
  (array_agg(m.user_id ORDER BY m.occurred_at))[1],
  (array_agg(m.source ORDER BY m.occurred_at))[1],
  MIN(m.occurred_at),
  extract(epoch from now())::bigint
FROM chat_messages m
WHERE m.conversation_id IS NOT NULL AND m.conversation_id <> ''
GROUP BY m.conversation_id
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

DROP TABLE chat_messages;

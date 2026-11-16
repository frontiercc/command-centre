-- The names of what an AI reply made, so Team coaching can list what a session produced, as it
-- already can for Claude Cowork and Claude in Office (cowork_messages.output_name):
--   Claude Chat (chat_assistant_meta): its artifacts' titles and its generated files' names.
--   ChatGPT (openai_replies): the names of the files OpenAI's export lists on the reply.
-- Names only, never a directory, the reply's text or a file's content, passed through the PII scrub
-- (lib/otel/output-name.ts). Both tables are deleted at the end of their retention window, so the
-- names go with them. NULL where a reply made nothing or was stored before this column existed.
ALTER TABLE "chat_assistant_meta" ADD COLUMN IF NOT EXISTS "output_names" text;
ALTER TABLE "openai_replies" ADD COLUMN IF NOT EXISTS "file_names" text;

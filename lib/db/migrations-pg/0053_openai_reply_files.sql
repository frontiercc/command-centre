-- ChatGPT replies (openai_replies): how many files OpenAI's export lists on the reply, so Work Pulse
-- can later say whether a ChatGPT conversation produced something, as it does for Claude Cowork,
-- Claude in Office and Claude Chat. A count only, never a file name or the reply's text. NULL when
-- the reply carried no files field at all, which is kept apart from an empty list: whether the
-- export leaves the field out for a reply with no files is to be confirmed on a real workspace.
ALTER TABLE "openai_replies" ADD COLUMN IF NOT EXISTS "files_count" integer;

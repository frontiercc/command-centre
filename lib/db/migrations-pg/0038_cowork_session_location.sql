-- Where a Cowork session ran, from the OTel `cowork_surface`
-- attribute (seen as `local` for the person's own computer and `remote` for
-- Anthropic's cloud). Only sessions started from Claude Desktop honour the
-- otlpContentCapture device policy; sessions started on the web or mobile
-- carry metadata only whatever the device says. Keeping the label lets
-- a redacted prompt be told apart: a Desktop that has not restarted, or a
-- web session no device setting reaches.
-- Forward-only: earlier rows stay NULL (not recorded).
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS session_location text;

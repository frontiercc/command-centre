-- Which Claude Desktop build and operating system sent each Claude Cowork user prompt, from the
-- OTel resource attributes service.version, os.type and os.version (lib/otel/client-info.ts).
-- NULL = not recorded (prompts stored before this release, or a client that sends none).
-- IF NOT EXISTS: a hub that already has these columns keeps them and their values.
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS client_version text;--> statement-breakpoint
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS os_type text;--> statement-breakpoint
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS os_version text;

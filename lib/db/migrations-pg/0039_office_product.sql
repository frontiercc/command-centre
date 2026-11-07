-- Claude in Excel, Word, PowerPoint and Outlook (Office agents) is
-- stored beside Cowork in Work Pulse. `product` says which app a row came
-- from: NULL = Cowork, otherwise excel / word / powerpoint / outlook. Rows
-- keep source = 'otel' (the capture path). Forward-only: earlier rows stay
-- NULL, which is correct because no Office telemetry was stored before.
ALTER TABLE cowork_messages ADD COLUMN IF NOT EXISTS product text;
--> statement-breakpoint
ALTER TABLE cowork_sessions ADD COLUMN IF NOT EXISTS product text;

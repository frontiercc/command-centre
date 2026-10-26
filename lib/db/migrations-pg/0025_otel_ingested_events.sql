CREATE TABLE IF NOT EXISTS otel_ingested_events (
  event_key TEXT PRIMARY KEY,
  received_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_ingested_events_received_at ON otel_ingested_events(received_at);

INSERT INTO config (key, value) VALUES ('code_meta_per_call_since', CAST(FLOOR(EXTRACT(EPOCH FROM now())) AS TEXT))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS otel_identity_conflicts (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  existing_user_id TEXT NOT NULL,
  new_email TEXT NOT NULL,
  new_user_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  decided_by TEXT,
  decided_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS otel_identity_conflicts_install_email_uq
  ON otel_identity_conflicts(installation_id, new_email);
CREATE INDEX IF NOT EXISTS idx_otel_identity_conflicts_status ON otel_identity_conflicts(status);

CREATE TABLE IF NOT EXISTS otel_identity_aliases (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conflict_id TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_identity_aliases_user ON otel_identity_aliases(user_id);

CREATE TABLE IF NOT EXISTS totp_consumed_steps (
  user_id     TEXT PRIMARY KEY,
  step        BIGINT NOT NULL,
  consumed_at BIGINT NOT NULL
);

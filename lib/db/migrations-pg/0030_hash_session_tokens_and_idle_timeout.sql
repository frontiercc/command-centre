-- Session hardening.
-- 1. Store only a SHA-256 hash of each session token, so a copy of the database
--    cannot be used to sign in. The raw tokens are hashed IN PLACE: the cookies
--    people already hold keep working, so nobody is signed out. Runs once
--    (drizzle journal); hashing twice would sign everyone out, never let anyone in.
-- 2. last_used_at for the idle timeout (lib/db/admin-queries.ts
--    SESSION_IDLE_TIMEOUT_S); existing sessions count as used now.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_used_at BIGINT;
--> statement-breakpoint
UPDATE admin_sessions
SET id = encode(sha256(convert_to(id, 'UTF8')), 'hex'),
    last_used_at = extract(epoch from now())::bigint;

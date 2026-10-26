// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres, following the blessed query pattern (see
// lib/db/error-queries.ts / lib/db/queries.ts for worked examples):
// getTypedClient() + schema.<table>, rowsAffected() for UPDATE/DELETE counts,
// app-clock timestamps (the lockout and session-expiry comparisons use
// the app clock).
//
// email normalization: admin_users.email is `citext`, so case-insensitive `=`
// works natively. The existing `.toLowerCase().trim()` normalization is
// redundant but harmless — left in place to minimise churn.
import { decryptSecret, encryptSecret, isEncrypted } from '@/lib/auth/secrets';
import { insertErrorEvents } from '@/lib/db/error-queries';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { getTypedClient } from './client';
import { schema } from './schema';

// ─── rowsAffected (mirrors lib/db/queries.ts's) ─────────────────────────────

/**
 * Affected-row count for UPDATE/DELETE. node-postgres's driver resolves
 * `db.update()/delete()` to the raw pg `QueryResult` (`.rowCount`).
 */
function rowsAffected(result: unknown): number {
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

// ─── Type definitions ─────────────────────────────────────────────────────

export type UserRole = 'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse';

export interface AdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  department: string | null;
  linked_cowork_user_id: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  totp_enabled: number;
  sso_enabled: number;
}

export interface AdminSessionRow {
  /** SHA-256 hex of the session token. The token itself lives only in the user's cookie. */
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  ip_address: string | null;
  user_agent: string | null;
  last_used_at?: number | null;
}

// ─── Session hardening ──────────────────────────────────────────
// The database stores only a SHA-256 hash of each session token, so a copy of
// the database cannot be used to sign in as anyone. Migration 0030 hashed the
// existing rows in place, so nobody was signed out by the change.
// A normal session also ends after SESSION_IDLE_TIMEOUT_S without use, on top
// of its absolute 24 h expiry. A "remember me" session (created with a 7-day
// lifetime) is exempt from the idle timeout: the person asked to stay signed in
//. last_used_at is refreshed at most every
// LAST_USED_WRITE_EVERY_S to keep writes cheap.
export const SESSION_IDLE_TIMEOUT_S = 8 * 60 * 60;
const LAST_USED_WRITE_EVERY_S = 5 * 60;
/** Lifetimes above this are "remember me" sessions (24 h vs 7 days; see admin-auth.ts). */
const REMEMBER_ME_MIN_LIFETIME_S = 2 * 24 * 60 * 60;

/** SQL: the session is not idle-expired (remember-me sessions never are). */
function notIdleExpired(nowS: number) {
  const t = schema.adminSessions;
  return sql`(${t.expires_at} - ${t.created_at} > ${REMEMBER_ME_MIN_LIFETIME_S} OR coalesce(${t.last_used_at}, ${t.created_at}) > ${nowS - SESSION_IDLE_TIMEOUT_S})`;
}
/** SQL: the session is idle-expired (a normal session unused for the idle timeout). */
function idleExpired(nowS: number) {
  const t = schema.adminSessions;
  return sql`(${t.expires_at} - ${t.created_at} <= ${REMEMBER_ME_MIN_LIFETIME_S} AND coalesce(${t.last_used_at}, ${t.created_at}) <= ${nowS - SESSION_IDLE_TIMEOUT_S})`;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Admin Users ──────────────────────────────────────────────────────────

export async function createAdminUser({
  email,
  passwordHash,
  displayName,
  role,
  department,
}: {
  email: string;
  passwordHash: string;
  displayName?: string | null;
  role?: UserRole;
  department?: string | null;
}): Promise<AdminUserRow> {
  const id = uuidv4();
  const normalizedEmail = email.toLowerCase().trim();
  const db = await getTypedClient();

  // Deliberate provisioning via this API always grants SSO eligibility —
  // the same "deliberate act ⇒ SSO-eligible" rule the migration 055 backfill applies.
  await db.insert(schema.adminUsers).values({
    id,
    email: normalizedEmail,
    password_hash: passwordHash,
    display_name: displayName ?? null,
    role: role ?? 'viewer',
    department: department ?? null,
    sso_enabled: 1,
  });

  return (await findAdminById(id)) as AdminUserRow;
}

export async function findAdminById(id: string): Promise<AdminUserRow | null> {
  const db = await getTypedClient();
  const rows = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, id)).limit(1);
  return (rows[0] as AdminUserRow | undefined) ?? null;
}

export async function findAdminByEmail(email: string): Promise<AdminUserRow | null> {
  const normalized = email.toLowerCase().trim();
  const db = await getTypedClient();
  const rows = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, normalized))
    .limit(1);
  return (rows[0] as AdminUserRow | undefined) ?? null;
}

export async function adminUserCount(): Promise<number> {
  const db = await getTypedClient();
  const rows = await db.select({ count: sql<number | string>`count(*)` }).from(schema.adminUsers);
  return Number(rows[0]?.count ?? 0);
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const db = await getTypedClient();
  const rows = await db.select().from(schema.adminUsers).orderBy(schema.adminUsers.created_at);
  return rows as AdminUserRow[];
}

export async function updateAdminLastLogin(id: string): Promise<void> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  await db
    .update(schema.adminUsers)
    .set({ last_login_at: nowS, updated_at: nowS })
    .where(eq(schema.adminUsers.id, id));
}

export async function updateAdminDepartment(id: string, department: string | null): Promise<boolean> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);

  const result = await db
    .update(schema.adminUsers)
    .set({ department, updated_at: nowS })
    .where(eq(schema.adminUsers.id, id));

  // Mirror department to users table so Pulse dashboards and dropdowns stay
  // in sync. The original raw SQL did this as an UPDATE...WHERE id = (SELECT
  // linked_cowork_user_id FROM admin_users WHERE id = ? AND linked_cowork_user_id
  // IS NOT NULL) — expressed here as select-then-conditional-update, which is
  // behaviourally identical (a NULL linked id means the WHERE never matches
  // either way) and avoids a scalar-subquery-in-WHERE.
  const linked = await db
    .select({ linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, id))
    .limit(1);
  const linkedId = linked[0]?.linked_cowork_user_id;
  if (linkedId) {
    await db.update(schema.users).set({ department }).where(eq(schema.users.id, linkedId));
  }

  return rowsAffected(result) > 0;
}

export async function updateAdminRole(id: string, role: UserRole): Promise<boolean> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const result = await db
    .update(schema.adminUsers)
    .set({ role, updated_at: nowS })
    .where(eq(schema.adminUsers.id, id));
  return rowsAffected(result) > 0;
}

/** password_hash of an account auto-enrolled from telemetry; never a usable password. */
export const OTEL_PENDING_PASSWORD = '__otel_pending__';

/**
 * Whether the organisation already has an activated account (a real password,
 * or SSO turned on) on this email's domain. Gates self-service activation of
 * auto-enrolled accounts in forgot-password: telemetry chooses those emails,
 * so an address on a domain nobody has been activated on proves nothing.
 */
export async function hasActivatedAccountOnDomain(email: string): Promise<boolean> {
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : '';
  if (!domain) return false;
  const db = await getTypedClient();
  const rows = await db
    .select({ id: schema.adminUsers.id })
    .from(schema.adminUsers)
    .where(and(
      or(
        sql`${schema.adminUsers.password_hash} <> ${OTEL_PENDING_PASSWORD}`,
        eq(schema.adminUsers.sso_enabled, 1),
      ),
      sql`split_part(lower(${schema.adminUsers.email}::text), '@', 2) = ${domain}`,
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Set a real password on an admin_users row, applying the "sentinel→real
 * transition" activation rule: when the account's PREVIOUS password_hash was
 * the OTel auto-enrolment sentinel ('__otel_pending__'), this is the first
 * deliberate provisioning act on a previously-dormant account, so sso_enabled
 * flips to 1 — the same rule migration 055's backfill and createAdminUser()
 * apply. An ordinary password change/reset on an already-real account never
 * touches sso_enabled (an admin may have deliberately disabled SSO on it).
 */
export async function updateAdminPasswordAndSso(id: string, passwordHash: string): Promise<boolean> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);

  const existing = await db
    .select({ password_hash: schema.adminUsers.password_hash })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, id))
    .limit(1);

  const wasSentinel = existing[0]?.password_hash === '__otel_pending__';

  const result = await db
    .update(schema.adminUsers)
    .set(
      wasSentinel
        ? { password_hash: passwordHash, sso_enabled: 1, updated_at: nowS }
        : { password_hash: passwordHash, updated_at: nowS },
    )
    .where(eq(schema.adminUsers.id, id));
  return rowsAffected(result) > 0;
}

/**
 * Direct admin toggle of SSO eligibility — distinct from the implicit
 * sentinel→real transition in updateAdminPasswordAndSso(). This is the
 * per-account toggle and bulk "Enable SSO for selected" action on the
 * Security admin page; it sets sso_enabled to exactly the requested value
 * regardless of the account's provenance (an admin can re-enable SSO on an
 * auto-enrolled account without setting a password, or disable it on a
 * deliberately-provisioned one).
 */
export async function updateAdminSsoEnabled(id: string, ssoEnabled: boolean): Promise<boolean> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const result = await db
    .update(schema.adminUsers)
    .set({ sso_enabled: ssoEnabled ? 1 : 0, updated_at: nowS })
    .where(eq(schema.adminUsers.id, id));
  return rowsAffected(result) > 0;
}

export async function updateAdminLinkedAgent(id: string, linkedCoworkUserId: string | null): Promise<boolean> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const result = await db
    .update(schema.adminUsers)
    .set({ linked_cowork_user_id: linkedCoworkUserId, updated_at: nowS })
    .where(eq(schema.adminUsers.id, id));
  return rowsAffected(result) > 0;
}

// ─── Admin Sessions ───────────────────────────────────────────────────────

export async function createSession({
  userId,
  expiresAt,
  ipAddress,
  userAgent,
}: {
  userId: string;
  expiresAt: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<AdminSessionRow & { token: string }> {
  // The token goes in the cookie; only its hash is stored.
  const token = crypto.randomBytes(32).toString('hex');
  const id = hashSessionToken(token);
  const db = await getTypedClient();

  await db.insert(schema.adminSessions).values({
    id,
    user_id: userId,
    expires_at: expiresAt,
    ip_address: ipAddress ?? null,
    user_agent: userAgent ?? null,
    last_used_at: Math.floor(Date.now() / 1000),
  });

  return { ...((await findSessionById(id)) as AdminSessionRow), token };
}

export async function findSessionById(id: string): Promise<AdminSessionRow | null> {
  const db = await getTypedClient();
  const rows = await db.select().from(schema.adminSessions).where(eq(schema.adminSessions.id, id)).limit(1);
  return (rows[0] as AdminSessionRow | undefined) ?? null;
}

/** Look up a session by the token from the cookie (hashed here; never stored raw). */
export async function findValidSession(
  token: string
): Promise<(AdminSessionRow & { user: AdminUserRow }) | null> {
  const db = await getTypedClient();
  // The "now" for the expiry comparison comes from the app clock.
  const nowS = Math.floor(Date.now() / 1000);
  const sessionId = hashSessionToken(token);

  const rows = await db
    .select({
      id: schema.adminSessions.id,
      user_id: schema.adminSessions.user_id,
      expires_at: schema.adminSessions.expires_at,
      created_at: schema.adminSessions.created_at,
      ip_address: schema.adminSessions.ip_address,
      user_agent: schema.adminSessions.user_agent,
      last_used_at: schema.adminSessions.last_used_at,
      u_id: schema.adminUsers.id,
      u_email: schema.adminUsers.email,
      u_password_hash: schema.adminUsers.password_hash,
      u_display_name: schema.adminUsers.display_name,
      u_role: schema.adminUsers.role,
      u_department: schema.adminUsers.department,
      u_linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id,
      u_created_at: schema.adminUsers.created_at,
      u_updated_at: schema.adminUsers.updated_at,
      u_last_login_at: schema.adminUsers.last_login_at,
      u_totp_enabled: schema.adminUsers.totp_enabled,
      u_sso_enabled: schema.adminUsers.sso_enabled,
    })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.user_id))
    .where(and(
      eq(schema.adminSessions.id, sessionId),
      gt(schema.adminSessions.expires_at, nowS),
      // Idle timeout: a normal session unused for SESSION_IDLE_TIMEOUT_S ends.
      notIdleExpired(nowS),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lastUsed = Number(row.last_used_at ?? row.created_at);
  if (nowS - lastUsed >= LAST_USED_WRITE_EVERY_S) {
    await db.update(schema.adminSessions).set({ last_used_at: nowS }).where(eq(schema.adminSessions.id, sessionId));
  }

  const session: AdminSessionRow = {
    id: row.id,
    user_id: row.user_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    last_used_at: row.last_used_at,
  };

  const user: AdminUserRow = {
    id: row.u_id,
    email: row.u_email,
    password_hash: row.u_password_hash,
    display_name: row.u_display_name,
    role: row.u_role as UserRole,
    department: row.u_department,
    linked_cowork_user_id: row.u_linked_cowork_user_id ?? null,
    created_at: row.u_created_at,
    updated_at: row.u_updated_at,
    last_login_at: row.u_last_login_at,
    totp_enabled: row.u_totp_enabled ?? 0,
    sso_enabled: row.u_sso_enabled ?? 0,
  };

  return { ...session, user };
}

export interface ActiveSessionRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  expires_at: number;
  created_at: number;
  ip_address: string | null;
  user_agent: string | null;
}

export async function listActiveSessions(): Promise<ActiveSessionRow[]> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000); // app clock

  const rows = await db
    .select({
      id: schema.adminSessions.id,
      user_id: schema.adminSessions.user_id,
      email: schema.adminUsers.email,
      display_name: schema.adminUsers.display_name,
      role: schema.adminUsers.role,
      expires_at: schema.adminSessions.expires_at,
      created_at: schema.adminSessions.created_at,
      ip_address: schema.adminSessions.ip_address,
      user_agent: schema.adminSessions.user_agent,
    })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.user_id))
    .where(and(
      gt(schema.adminSessions.expires_at, nowS),
      notIdleExpired(nowS),
    ))
    .orderBy(desc(schema.adminSessions.created_at));

  return rows.map((r) => ({ ...r, role: r.role as UserRole }));
}

/** Delete by stored id (the hash), as listed on the sessions admin page. */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const db = await getTypedClient();
  const result = await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, sessionId));
  return rowsAffected(result) > 0;
}

/** Delete by the token from a cookie (logout). */
export async function deleteSessionByToken(token: string): Promise<boolean> {
  return deleteSession(hashSessionToken(token));
}

export async function deleteExpiredSessions(): Promise<number> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000); // app clock
  // Past their absolute expiry, or idle for longer than the idle timeout.
  const result = await db.delete(schema.adminSessions).where(or(
    lte(schema.adminSessions.expires_at, nowS),
    idleExpired(nowS),
  ));
  return rowsAffected(result);
}

export async function deleteUserSessions(userId: string): Promise<number> {
  const db = await getTypedClient();
  const result = await db.delete(schema.adminSessions).where(eq(schema.adminSessions.user_id, userId));
  return rowsAffected(result);
}

export async function deleteAdminUser(id: string): Promise<boolean> {
  const db = await getTypedClient();
  // The TOTP replay-guard claim (migration 078) carries no FK, so it is not
  // cascaded away with the account — clear it explicitly. Done BEFORE the
  // account delete so a failure here can't leave an orphan row behind.
  await db.delete(schema.totpConsumedSteps).where(eq(schema.totpConsumedSteps.user_id, id));
  const result = await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, id));
  return rowsAffected(result) > 0;
}

// ─── TOTP / MFA ──────────────────────────────────────────────────────────

export async function enableTotp(userId: string, secret: string, recoveryHashes: string[]): Promise<void> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);

  await db
    .update(schema.adminUsers)
    // Release 2: the seed is stored encrypted, like config secrets.
    .set({ totp_secret: encryptSecret(secret), totp_enabled: 1, updated_at: nowS })
    .where(eq(schema.adminUsers.id, userId));

  // Replace any existing recovery codes.
  await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.user_id, userId));
  if (recoveryHashes.length > 0) {
    await db.insert(schema.totpRecoveryCodes).values(
      recoveryHashes.map((hash) => ({ id: uuidv4(), user_id: userId, code_hash: hash })),
    );
  }
}

export async function disableTotp(userId: string): Promise<void> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);

  await db
    .update(schema.adminUsers)
    .set({ totp_secret: null, totp_enabled: 0, updated_at: nowS })
    .where(eq(schema.adminUsers.id, userId));
  await db.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.user_id, userId));
  // Replay-guard claim for the now-removed secret (migration 078) — no FK, so
  // it is cleared here rather than lingering keyed by the user's id.
  await db.delete(schema.totpConsumedSteps).where(eq(schema.totpConsumedSteps.user_id, userId));
}

export async function getTotpStatus(userId: string): Promise<{ enabled: boolean; secret: string | null }> {
  const db = await getTypedClient();
  const rows = await db
    .select({ totp_enabled: schema.adminUsers.totp_enabled, totp_secret: schema.adminUsers.totp_secret })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return { enabled: false, secret: null };
  return { enabled: row.totp_enabled === 1, secret: readTotpSeed(userId, row.totp_secret) };
}

const reportedUnreadableSeeds = new Set<string>();
/**
 * MFA seeds are stored encrypted (`enc:`, same helper as config secrets).
 * Release 1 taught reads to decrypt; release 2
 * encrypts on write and converts old rows at boot (encryptStoredTotpSeeds).
 * A plaintext seed is still returned as-is — seeds are base32, so they can
 * never start with `enc:`. NEVER roll back to an image older than release 1
 * (`ba186b91`): it cannot read an encrypted seed. A seed that cannot be
 * decrypted is recorded once per process in error_events (source totp-seed)
 * instead of silently failing the login.
 */
export function readTotpSeed(userId: string, stored: string | null): string | null {
  if (!stored || !isEncrypted(stored)) return stored;
  const seed = decryptSecret(stored);
  if (seed) return seed;
  if (!reportedUnreadableSeeds.has(userId)) {
    reportedUnreadableSeeds.add(userId);
    void insertErrorEvents([{ severity: 'error', source: 'totp-seed', message: `MFA seed for admin user ${userId} cannot be decrypted with this server's CCC_ENCRYPTION_KEY; the user can sign in with a recovery code, or an admin can reset their MFA.` }]).catch(() => { /* never break a login path */ });
  }
  return null;
}

/**
 * Encrypt any MFA seed still stored as plaintext (run at boot, release 2).
 * Safe on every instance at once: each UPDATE only matches the exact
 * plaintext it read, so a row another instance already converted is left alone.
 */
export async function encryptStoredTotpSeeds(): Promise<{ encrypted: number }> {
  const db = await getTypedClient();
  const t = schema.adminUsers;
  const rows = await db.select({ id: t.id, seed: t.totp_secret }).from(t).where(sql`${t.totp_secret} IS NOT NULL`);
  let encrypted = 0;
  for (const r of rows) {
    if (!r.seed || isEncrypted(r.seed)) continue;
    const res = await db.update(t).set({ totp_secret: encryptSecret(r.seed) }).where(and(eq(t.id, r.id), eq(t.totp_secret, r.seed)));
    encrypted += rowsAffected(res);
  }
  return { encrypted };
}

export async function consumeTotpRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
  const db = await getTypedClient();

  const rows = await db
    .select({ id: schema.totpRecoveryCodes.id })
    .from(schema.totpRecoveryCodes)
    .where(
      and(
        eq(schema.totpRecoveryCodes.user_id, userId),
        eq(schema.totpRecoveryCodes.code_hash, codeHash),
        isNull(schema.totpRecoveryCodes.used_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;

  // Claimed only while still unused, so of two requests racing with the same
  // code only one succeeds (security re-review).
  const nowS = Math.floor(Date.now() / 1000);
  const claimed = await db
    .update(schema.totpRecoveryCodes)
    .set({ used_at: nowS })
    .where(and(eq(schema.totpRecoveryCodes.id, row.id), isNull(schema.totpRecoveryCodes.used_at)))
    .returning({ id: schema.totpRecoveryCodes.id });
  return claimed.length > 0;
}

// ─── Password Reset Tokens ────────────────────────────────────────────────

export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const id = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const db = await getTypedClient();

  // Invalidate any previous unused tokens for this user.
  await db
    .delete(schema.passwordResetTokens)
    .where(and(eq(schema.passwordResetTokens.user_id, userId), isNull(schema.passwordResetTokens.used_at)));

  await db.insert(schema.passwordResetTokens).values({
    id,
    user_id: userId,
    token_hash: hash,
    expires_at: expiresAt,
  });

  return raw;
}

export async function consumePasswordResetToken(
  rawToken: string
): Promise<{ userId: string } | null> {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000); // app clock

  const rows = await db
    .select()
    .from(schema.passwordResetTokens)
    .where(
      and(
        eq(schema.passwordResetTokens.token_hash, hash),
        isNull(schema.passwordResetTokens.used_at),
        gt(schema.passwordResetTokens.expires_at, nowS),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Claimed only while still unused: of two requests racing with the same
  // token only one sets a password (security re-review).
  const claimed = await db
    .update(schema.passwordResetTokens)
    .set({ used_at: nowS })
    .where(and(eq(schema.passwordResetTokens.id, row.id), isNull(schema.passwordResetTokens.used_at)))
    .returning({ id: schema.passwordResetTokens.id });
  if (claimed.length === 0) return null;

  return { userId: row.user_id };
}

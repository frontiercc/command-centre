// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/db/admin-queries.ts (admin users,
// admin sessions, TOTP/MFA, password-reset tokens) and the closely-coupled
// lib/auth/lockout.ts (per-account brute-force lockout — reads/writes the
// same admin_users columns, so it is exercised here too rather than only on
// a mocked leg).
//
// Runs against Postgres (testcontainers postgres:16, or the shared server
// named by CCC_TEST_PG_URL); skipped (not failed) without Docker.
// createTestDbClient('postgres') already ran the full lib/db/migrations-pg
// set (citext admin_users.email) via startPg(), so no per-test DDL
// is needed.
//
// HARNESS RULE (copied from queries-users-pg.test.ts): admin-queries.ts and
// lockout.ts reach the database through getClient(), which binds to
// DATABASE_URL on first use — so the modules-under-test (and `schema`)
// are DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL +
// reset modules.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const adminQueries = await import('@/lib/db/admin-queries');
    const lockout = await import('@/lib/auth/lockout');
    const {
      createAdminUser, findAdminById, findAdminByEmail, adminUserCount,
      listAdminUsers, updateAdminRole, updateAdminDepartment, updateAdminLinkedAgent,
      createSession, findValidSession, listActiveSessions, deleteSession,
      deleteExpiredSessions, deleteUserSessions,
      enableTotp, getTotpStatus, consumeTotpRecoveryCode, disableTotp, deleteAdminUser,
      createPasswordResetToken, consumePasswordResetToken,
    } = adminQueries;
    const { isAccountLocked, recordFailedLogin, clearFailedLogins, MAX_FAILED_ATTEMPTS } = lockout;

    // ── createAdminUser / findAdminById / adminUserCount ────────────────
    expect(await adminUserCount()).toBe(0);
    const created = await createAdminUser({
      email: 'Admin@Example.com',
      passwordHash: 'hash-1',
      displayName: 'Admin One',
      role: 'admin',
    });
    expect(created.email).toBe('admin@example.com'); // app-side .toLowerCase() normalization
    expect(created.sso_enabled).toBe(1); // deliberate provisioning ⇒ SSO-eligible
    expect(await adminUserCount()).toBe(1);
    expect((await findAdminById(created.id))?.id).toBe(created.id);
    expect(await findAdminById('does-not-exist')).toBeNull();

    // ── findAdminByEmail: mixed-case input resolves via app normalization ──
    // admin-queries.ts's .toLowerCase().trim() runs BEFORE the query, so this exercises the normalized-lookup contract end-to-end
    // (async Drizzle read after the async Drizzle write). The DB-level
    // case-insensitive collation itself (Postgres citext — the backstop the code comments describe as "redundant but
    // harmless" given this app-side normalization) is already proven directly
    // against the raw driver in test/email-citext.test.ts; not
    // re-asserted here to avoid duplicating that coverage.
    const byEmailMixedCase = await findAdminByEmail('ADMIN@EXAMPLE.COM');
    expect(byEmailMixedCase?.id).toBe(created.id);
    expect(await findAdminByEmail('nobody@example.com')).toBeNull();

    // ── listAdminUsers + a second user for role-count checks ─────────────
    const second = await createAdminUser({
      email: 'viewer@example.com',
      passwordHash: 'hash-2',
      role: 'viewer',
      department: 'Engineering',
    });
    expect((await listAdminUsers()).map((u) => u.id).sort()).toEqual([created.id, second.id].sort());

    // ── updateAdminRole: rowcount-based update (rowsAffected) ────────────
    const roleChanged = await updateAdminRole(second.id, 'manager');
    expect(roleChanged).toBe(true); // 1 row affected -> true
    expect((await findAdminById(second.id))?.role).toBe('manager');
    const roleChangedMissing = await updateAdminRole('does-not-exist', 'manager');
    expect(roleChangedMissing).toBe(false); // 0 rows affected -> false

    // ── updateAdminDepartment: mirrors to users table via linked agent ───
    const { schema: schemaForSeed } = await import('@/lib/db/schema');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schemaForSeed.users).values({
      id: 'cowork-user-1',
      email: 'cowork1@example.com',
      display_name: 'Cowork One',
    });
    const linked = await updateAdminLinkedAgent(second.id, 'cowork-user-1');
    expect(linked).toBe(true);
    const deptChanged = await updateAdminDepartment(second.id, 'Sales');
    expect(deptChanged).toBe(true);
    expect((await findAdminById(second.id))?.department).toBe('Sales');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mirroredUser = (await (client as any).select().from(schemaForSeed.users).where(eq(schemaForSeed.users.id, 'cowork-user-1')))[0];
    expect(mirroredUser?.department).toBe('Sales'); // mirrored to users table

    // ── Admin sessions: create / findValidSession / list / delete ────────
    const nowS = Math.floor(Date.now() / 1000);
    const session = await createSession({
      userId: created.id,
      expiresAt: nowS + 3600,
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    const valid = await findValidSession(session.token);
    expect(valid?.user.id).toBe(created.id);
    expect(valid?.user.email).toBe('admin@example.com');

    const active = await listActiveSessions();
    expect(active.map((s) => s.id)).toContain(session.id);

    // Expired session round-trip: create one already expired, prove
    // findValidSession excludes it and deleteExpiredSessions removes it.
    const expiredSession = await createSession({ userId: created.id, expiresAt: nowS - 10 });
    expect(await findValidSession(expiredSession.token)).toBeNull();
    const purged = await deleteExpiredSessions();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await findValidSession(expiredSession.token)).toBeNull();

    const deleted = await deleteSession(session.id);
    expect(deleted).toBe(true);
    expect(await findValidSession(session.token)).toBeNull();
    expect(await deleteSession('does-not-exist')).toBe(false);

    // deleteUserSessions: bulk-revoke by user
    await createSession({ userId: created.id, expiresAt: nowS + 3600 });
    await createSession({ userId: created.id, expiresAt: nowS + 3600 });
    const revokedCount = await deleteUserSessions(created.id);
    expect(revokedCount).toBe(2);

    // ── TOTP / MFA round-trip ─────────────────────────────────────────────
    expect((await getTotpStatus(created.id)).enabled).toBe(false);
    await enableTotp(created.id, 'SECRET123', ['recovery-hash-1', 'recovery-hash-2']);
    const totpStatus = await getTotpStatus(created.id);
    expect(totpStatus.enabled).toBe(true);
    expect(totpStatus.secret).toBe('SECRET123');

    expect(await consumeTotpRecoveryCode(created.id, 'wrong-hash')).toBe(false);
    expect(await consumeTotpRecoveryCode(created.id, 'recovery-hash-1')).toBe(true);
    // A recovery code is single-use.
    expect(await consumeTotpRecoveryCode(created.id, 'recovery-hash-1')).toBe(false);
    expect(await consumeTotpRecoveryCode(created.id, 'recovery-hash-2')).toBe(true);

    await disableTotp(created.id);
    expect((await getTotpStatus(created.id)).enabled).toBe(false);

    // ── TOTP replay-guard claim (migration 078) is cleaned up ────────────
    // The claim row deliberately carries no FK (an FK failure on the auth
    // path would lock a user out), so
    // nothing removes it for us: disabling MFA and deleting the admin must
    // each clear it rather than leaving an orphan keyed by a person's id.
    const claimRowsFor = async (id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).select().from(schemaForSeed.totpConsumedSteps)
        .where(eq(schemaForSeed.totpConsumedSteps.user_id, id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schemaForSeed.totpConsumedSteps)
      .values({ user_id: created.id, step: 1, consumed_at: nowS });
    expect((await claimRowsFor(created.id)).length).toBe(1);
    await disableTotp(created.id);
    expect(await claimRowsFor(created.id)).toEqual([]);

    // The replay guard itself. Its check-and-claim is a single conditional
    // upsert (`setWhere` + `excluded`), proven here on the backend every real
    // instance actually runs.
    const { generateTotpSecret, currentTotpCode, verifyAndConsumeTotp } = await import('@/lib/auth/totp');
    const replaySecret = generateTotpSecret();
    const replayCode = currentTotpCode(replaySecret);
    expect(await verifyAndConsumeTotp(created.id, replayCode, replaySecret)).toBe(true);
    expect(await verifyAndConsumeTotp(created.id, replayCode, replaySecret)).toBe(false); // replay
    expect((await claimRowsFor(created.id)).length).toBe(1);
    await disableTotp(created.id);

    // ── Password reset tokens ────────────────────────────────────────────
    const rawToken = await createPasswordResetToken(created.id);
    expect(typeof rawToken).toBe('string');
    const consumed = await consumePasswordResetToken(rawToken);
    expect(consumed?.userId).toBe(created.id);
    // Single-use: consuming again fails.
    expect(await consumePasswordResetToken(rawToken)).toBeNull();
    expect(await consumePasswordResetToken('not-a-real-token')).toBeNull();

    // ── Per-account lockout (lib/auth/lockout.ts) ────────────────────────
    // Increments without locking below the threshold.
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      const r = await recordFailedLogin(second.id);
      expect(r.locked).toBe(false);
    }
    expect((await isAccountLocked(second.id)).locked).toBe(false);

    // The threshold-th failure locks the account.
    const finalAttempt = await recordFailedLogin(second.id);
    expect(finalAttempt.locked).toBe(true);
    expect(finalAttempt.until).toBeGreaterThan(nowS);
    expect((await isAccountLocked(second.id)).locked).toBe(true);

    // clearFailedLogins resets the counter and unlocks.
    await clearFailedLogins(second.id);
    expect((await isAccountLocked(second.id)).locked).toBe(false);

    // Auto-expiry: force a lock that has already elapsed and prove
    // isAccountLocked lazily clears it (reads as unlocked + resets counter).
    const pastUntil = nowS - 60;
    const { sql } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).execute(
      sql`UPDATE admin_users SET failed_login_count = ${MAX_FAILED_ATTEMPTS}, locked_until = ${pastUntil} WHERE id = ${second.id}`,
    );
    const expiredLock = await isAccountLocked(second.id);
    expect(expiredLock.locked).toBe(false); // expired -> unlocked + counter reset
    // A fresh failure right after doesn't immediately re-lock.
    expect((await recordFailedLogin(second.id)).locked).toBe(false);

    // ── Deleting an admin clears their replay-guard claim ────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schemaForSeed.totpConsumedSteps)
      .values({ user_id: second.id, step: 2, consumed_at: nowS });
    expect((await claimRowsFor(second.id)).length).toBe(1);
    expect(await deleteAdminUser(second.id)).toBe(true);
    expect(await claimRowsFor(second.id)).toEqual([]);
  } finally {
    await cleanup();
  }
}

describe('admin-queries + lockout (postgres)', () => {
  it(
    'admin users, sessions, MFA, password-reset tokens, and lockout behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

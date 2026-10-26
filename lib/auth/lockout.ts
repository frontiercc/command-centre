// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-account brute-force lockout for admin login.
 *
 * Complements the per-IP rate limit (5/60s in the login route) by catching
 * distributed attempts against a single account. After MAX_FAILED_ATTEMPTS
 * failures the account is locked for LOCKOUT_SECONDS — a TEMPORARY, auto-expiring
 * lock (no permanent lockout, which would be a denial-of-service lever). The
 * counter resets on any successful login. DB-backed (admin_users), so it survives
 * restarts and admins can inspect/clear it.
 */
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const MAX_FAILED_ATTEMPTS = 10;
export const LOCKOUT_SECONDS = 15 * 60; // 15 minutes

const nowSec = () => Math.floor(Date.now() / 1000);

/** Current lock state. Lazily clears an expired lock so the user gets a fresh window. */
export async function isAccountLocked(userId: string): Promise<{ locked: boolean; until: number | null }> {
  const db = await getTypedClient();
  const rows = await db
    .select({ locked_until: schema.adminUsers.locked_until })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, userId))
    .limit(1);
  const until = rows[0]?.locked_until ?? null;
  if (until && until > nowSec()) return { locked: true, until };
  if (until && until <= nowSec()) {
    // Lock expired — reset the counter for a fresh window.
    await db
      .update(schema.adminUsers)
      .set({ failed_login_count: 0, locked_until: null })
      .where(eq(schema.adminUsers.id, userId));
  }
  return { locked: false, until: null };
}

/** Record a failed login; lock the account once the threshold is reached. */
export async function recordFailedLogin(userId: string): Promise<{ locked: boolean; until: number | null }> {
  const db = await getTypedClient();
  const rows = await db
    .select({ failed_login_count: schema.adminUsers.failed_login_count })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, userId))
    .limit(1);
  const count = (rows[0]?.failed_login_count ?? 0) + 1;
  if (count >= MAX_FAILED_ATTEMPTS) {
    const until = nowSec() + LOCKOUT_SECONDS;
    await db
      .update(schema.adminUsers)
      .set({ failed_login_count: count, locked_until: until })
      .where(eq(schema.adminUsers.id, userId));
    return { locked: true, until };
  }
  await db
    .update(schema.adminUsers)
    .set({ failed_login_count: count })
    .where(eq(schema.adminUsers.id, userId));
  return { locked: false, until: null };
}

/** Clear failed-login state on a successful authentication. */
export async function clearFailedLogins(userId: string): Promise<void> {
  const db = await getTypedClient();
  await db
    .update(schema.adminUsers)
    .set({ failed_login_count: 0, locked_until: null })
    .where(eq(schema.adminUsers.id, userId));
}

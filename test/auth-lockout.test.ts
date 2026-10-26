// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let lockout: typeof import('@/lib/auth/lockout');

const UID = 'admin_lock_test';

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  lockout = await import('@/lib/auth/lockout');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.run('DELETE FROM admin_users WHERE id = ?', [UID]);
  await sql.run(
    `INSERT INTO admin_users (id, email, password_hash, display_name, role)
     VALUES (?, 'lock@test.local', 'x', 'Lock Test', 'admin')`,
    [UID],
  );
});

describe('per-account login lockout', () => {
  it('locks after MAX_FAILED_ATTEMPTS failures, not before', async () => {
    for (let i = 1; i < lockout.MAX_FAILED_ATTEMPTS; i++) {
      const r = await lockout.recordFailedLogin(UID);
      expect(r.locked).toBe(false);
    }
    expect((await lockout.isAccountLocked(UID)).locked).toBe(false);
    const final = await lockout.recordFailedLogin(UID); // the 10th
    expect(final.locked).toBe(true);
    expect(final.until).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect((await lockout.isAccountLocked(UID)).locked).toBe(true);
  });

  it('clears on successful login', async () => {
    for (let i = 0; i < lockout.MAX_FAILED_ATTEMPTS; i++) await lockout.recordFailedLogin(UID);
    expect((await lockout.isAccountLocked(UID)).locked).toBe(true);
    await lockout.clearFailedLogins(UID);
    expect((await lockout.isAccountLocked(UID)).locked).toBe(false);
    const row = (await sql.get('SELECT failed_login_count, locked_until FROM admin_users WHERE id = ?', [UID])) as { failed_login_count: number; locked_until: number | null };
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it('auto-expires: an elapsed lock reads as unlocked and resets the counter', async () => {
    // Force a lock that already expired.
    await sql.run('UPDATE admin_users SET failed_login_count = 10, locked_until = ? WHERE id = ?',
      [Math.floor(Date.now() / 1000) - 60, UID]);
    expect((await lockout.isAccountLocked(UID)).locked).toBe(false); // expired → unlocked + reset
    const row = (await sql.get('SELECT failed_login_count, locked_until FROM admin_users WHERE id = ?', [UID])) as { failed_login_count: number; locked_until: number | null };
    expect(row.failed_login_count).toBe(0);
    // and a fresh failure starts the count over (not immediately re-locked)
    expect((await lockout.recordFailedLogin(UID)).locked).toBe(false);
  });
});

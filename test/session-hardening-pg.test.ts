// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Session hardening: only a hash of each session token is stored,
// existing sessions were hashed in place (nobody signed out), and a session
// ends after SESSION_IDLE_TIMEOUT_S without use.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let q: typeof import('@/lib/db/admin-queries');
let userId: string;

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  q = await import('@/lib/db/admin-queries');
  const u = await q.createAdminUser({ email: 'sess@example.com', passwordHash: 'x', displayName: null, role: 'admin' });
  userId = u.id;
});
afterAll(async () => cleanup());

const now = () => Math.floor(Date.now() / 1000);

describe('session tokens are stored only as hashes', () => {
  it('the stored id is the SHA-256 of the cookie token, never the token', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 3600 });
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.id).toBe(crypto.createHash('sha256').update(s.token).digest('hex'));
    const raw = await sql.get<{ n: number }>('SELECT count(*) AS n FROM admin_sessions WHERE id = ?', [s.token]);
    expect(Number(raw!.n)).toBe(0);
  });

  it('the cookie token signs in; the stored id does not', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 3600 });
    expect((await q.findValidSession(s.token))?.user.id).toBe(userId);
    expect(await q.findValidSession(s.id)).toBeNull(); // a copied database row is useless as a cookie
  });

  it('logout by token deletes the session', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 3600 });
    expect(await q.deleteSessionByToken(s.token)).toBe(true);
    expect(await q.findValidSession(s.token)).toBeNull();
  });
});

describe('idle timeout', () => {
  it('a normal session unused for longer than the idle timeout is refused, and cleaned up', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 86400 }); // normal 24 h session
    await sql.run('UPDATE admin_sessions SET last_used_at = ? WHERE id = ?', [now() - q.SESSION_IDLE_TIMEOUT_S - 60, s.id]);
    expect(await q.findValidSession(s.token)).toBeNull();
    expect((await q.listActiveSessions()).some(r => r.id === s.id)).toBe(false);
    await q.deleteExpiredSessions();
    expect(await sql.get('SELECT 1 FROM admin_sessions WHERE id = ?', [s.id])).toBeUndefined();
  });

  it('use refreshes last_used_at (at most every few minutes), keeping an active session alive', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 86400 });
    const old = now() - q.SESSION_IDLE_TIMEOUT_S + 600; // 10 min before it would expire
    await sql.run('UPDATE admin_sessions SET last_used_at = ? WHERE id = ?', [old, s.id]);
    expect(await q.findValidSession(s.token)).not.toBeNull();
    const row = await sql.get<{ last_used_at: number }>('SELECT last_used_at FROM admin_sessions WHERE id = ?', [s.id]);
    expect(Number(row!.last_used_at)).toBeGreaterThan(old + 300);
  });

  it('a "remember me" session (7-day lifetime) is exempt from the idle timeout', async () => {
    const s = await q.createSession({ userId, expiresAt: now() + 7 * 86400 });
    await sql.run('UPDATE admin_sessions SET last_used_at = ? WHERE id = ?', [now() - q.SESSION_IDLE_TIMEOUT_S - 3600, s.id]);
    expect(await q.findValidSession(s.token)).not.toBeNull();
    expect((await q.listActiveSessions()).some(r => r.id === s.id)).toBe(true);
    await q.deleteExpiredSessions();
    expect(await sql.get('SELECT 1 FROM admin_sessions WHERE id = ?', [s.id])).toBeDefined();
  });

  it('the absolute expiry still applies', async () => {
    const s = await q.createSession({ userId, expiresAt: now() - 1 });
    expect(await q.findValidSession(s.token)).toBeNull();
  });
});

describe('migration 0030', () => {
  it('hashes existing raw-token rows in place, so the cookies people hold keep working', async () => {
    // A pre-migration row: id is the raw token, no last_used_at.
    const token = crypto.randomBytes(32).toString('hex');
    await sql.run('INSERT INTO admin_sessions (id, user_id, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)', [token, userId, now() + 3600, now() - 60]);
    // Only this row, as the migration would do to every row at deploy time.
    const file = path.join(process.cwd(), 'lib/db/migrations-pg/0030_hash_session_tokens_and_idle_timeout.sql');
    const update = fs.readFileSync(file, 'utf8').split('--> statement-breakpoint')[1].split(/\r?\n/).filter(l => !l.startsWith('--')).join(' ').trim().replace(/;$/, '');
    await sql.run(`${update} WHERE id = ?`, [token]);
    expect(await sql.get('SELECT 1 FROM admin_sessions WHERE id = ?', [token])).toBeUndefined();
    expect((await q.findValidSession(token))?.user.id).toBe(userId);
  });
});

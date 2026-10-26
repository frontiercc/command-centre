// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// First-admin setup token on Postgres: a fresh
// install can only be claimed with the token printed in the server log, and two
// simultaneous setup requests can never both become admin.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = 1_790_000_000;

beforeAll(async () => { ({ sql, cleanup } = await createTestDatabase()); });
afterAll(async () => cleanup());

const post = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/admin/setup', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const admins = async () => Number((await sql.get<{ n: number }>('SELECT count(*) AS n FROM admin_users'))!.n);

describe('first-admin setup token', () => {
  it('issues once, refuses a second issue inside 10 minutes, rotates after', async () => {
    const { issueSetupTokenIfNeeded, hashSetupToken, SETUP_TOKEN_KEY } = await import('@/lib/auth/setup-token');
    const zero = async () => 0;
    const a = await issueSetupTokenIfNeeded(zero, NOW);
    expect(a.status).toBe('issued');
    expect(await issueSetupTokenIfNeeded(zero, NOW + 60)).toEqual({ status: 'already_issued' });
    const row = await sql.get<{ value: string }>('SELECT value FROM config WHERE key = ?', [SETUP_TOKEN_KEY]);
    expect(row!.value).toBe(hashSetupToken((a as { token: string }).token)); // only the hash is stored
    const b = await issueSetupTokenIfNeeded(zero, NOW + 700);
    expect(b.status).toBe('issued');
  });

  it('refuses setup without the token or with a wrong one', async () => {
    const route = await import('@/app/api/admin/setup/route');
    const base = { email: 'first@example.com', password: 'correct-horse-battery' };
    expect((await route.POST(post(base))).status).toBe(403);
    expect((await route.POST(post({ ...base, setupToken: 'nope' }))).status).toBe(403);
    expect(await admins()).toBe(0);
  });

  it('a form error does not burn the token', async () => {
    const { issueSetupTokenIfNeeded } = await import('@/lib/auth/setup-token');
    const r = await issueSetupTokenIfNeeded(async () => 0, NOW + 2000);
    const token = (r as { token: string }).token;
    const route = await import('@/app/api/admin/setup/route');
    expect((await route.POST(post({ setupToken: token, email: 'x@example.com', password: 'short-pass' }))).status).toBe(400);
    const again = await route.POST(post({ setupToken: token, email: 'solo@example.com', password: 'correct-horse-battery' }));
    expect(again.status).toBe(201);
    expect(await admins()).toBe(1);
    await sql.run('DELETE FROM admin_sessions');
    await sql.run('DELETE FROM admin_users');
  });

  it('two simultaneous requests with the right token: exactly one becomes admin', async () => {
    const { issueSetupTokenIfNeeded } = await import('@/lib/auth/setup-token');
    const r = await issueSetupTokenIfNeeded(async () => 0, NOW + 4000);
    const token = (r as { token: string }).token;
    const route = await import('@/app/api/admin/setup/route');
    const [x, y] = await Promise.all([
      route.POST(post({ setupToken: token, email: 'alice@example.com', password: 'correct-horse-battery' })),
      route.POST(post({ setupToken: token, email: 'mallory@example.com', password: 'correct-horse-battery' })),
    ]);
    // One wins. The other is refused: 403 if it reached the token after the
    // winner claimed it, or 409 if the winner had already finished (under load
    // the first request can complete before the second starts). Either way,
    // exactly one admin.
    const statuses = [x.status, y.status].sort();
    expect(statuses[0]).toBe(201);
    expect([403, 409]).toContain(statuses[1]);
    expect(await admins()).toBe(1);
  });

  it('two simultaneous claims of the same token: exactly one succeeds', async () => {
    const { issueSetupTokenIfNeeded, claimSetupToken } = await import('@/lib/auth/setup-token');
    await sql.run('DELETE FROM config WHERE key = ?', ['setup_token_hash']);
    const r = await issueSetupTokenIfNeeded(async () => 0, NOW + 6000);
    const token = (r as { token: string }).token;
    const results = await Promise.all(Array.from({ length: 8 }, () => claimSetupToken(token)));
    expect(results.filter(c => c.claimed)).toHaveLength(1);
  });

  it('once an admin exists, boot clears any leftover token and issues none', async () => {
    const { issueSetupTokenIfNeeded, SETUP_TOKEN_KEY } = await import('@/lib/auth/setup-token');
    await sql.run('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', [SETUP_TOKEN_KEY, 'stale', NOW]);
    expect(await issueSetupTokenIfNeeded(async () => 1, NOW + 9000)).toEqual({ status: 'not_needed' });
    expect(await sql.get('SELECT 1 FROM config WHERE key = ?', [SETUP_TOKEN_KEY])).toBeUndefined();
  });
});

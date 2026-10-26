// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Security fixes for low-severity items.
// Real Postgres; only getAdminSession is mocked (for the Board
// routes); sign-in and MFA run through the real routes.
//   L1  wrong MFA codes count against the per-account lock, and a correct
//       password no longer resets the count while MFA is pending
//   L3  recovery codes and reset tokens are single-use under simultaneous use
//   L2  S&C Board source links must be http or https
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let session: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null } = { authenticated: false };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => session };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
let n = 0;
const ip = () => `10.33.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const UID = 'mfa-lock-user';
const EMAIL = 'mfa-lock@t.test';
const PASSWORD = 'correct horse battery staple';
let secret = '';

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  const { hashPassword } = await import('@/lib/auth/admin-auth');
  const { generateTotpSecret, generateRecoveryCodes } = await import('@/lib/auth/totp');
  const { enableTotp } = await import('@/lib/db/admin-queries');
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled) VALUES (?, ?, ?, 'Mfa User', 'admin', 0)`, [UID, EMAIL, hashPassword(PASSWORD)]);
  secret = generateTotpSecret();
  await enableTotp(UID, secret, generateRecoveryCodes(2).hashed);
  await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('u-lib', 'lib@t.test', 'Lib Author')`);
}, 120_000);
afterAll(async () => cleanup?.());

async function signIn(): Promise<string> {
  const { POST } = await import('../app/api/admin/login/route');
  const res = await POST(new NextRequest('http://localhost/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).mfaRequired).toBe(true);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
async function verify(cookie: string, code: string): Promise<number> {
  const { POST } = await import('../app/api/admin/mfa/verify/route');
  const res = await POST(new NextRequest('http://localhost/api/admin/mfa/verify', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie },
    body: JSON.stringify({ code }),
  }));
  return res.status;
}
const failedCount = async () => Number(((await sql.get('SELECT failed_login_count FROM admin_users WHERE id = ?', [UID])) as { failed_login_count: number }).failed_login_count);
const resetLock = () => sql.run('UPDATE admin_users SET failed_login_count = 0, locked_until = NULL WHERE id = ?', [UID]);

describe('L1: per-account limit on MFA code guessing', () => {
  it('a correct password does not reset the count while MFA is pending; a right code clears it', async () => {
    await resetLock();
    let cookie = await signIn();
    for (let i = 0; i < 3; i++) expect(await verify(cookie, '000000')).toBe(401);
    cookie = await signIn();
    expect(await failedCount()).toBe(3);
    const { currentTotpCode } = await import('@/lib/auth/totp');
    expect(await verify(cookie, currentTotpCode(secret))).toBe(200);
    expect(await failedCount()).toBe(0);
  });

  it('ten wrong codes lock the account, after which even a correct password and code are refused', async () => {
    await resetLock();
    const { MAX_FAILED_ATTEMPTS } = await import('@/lib/auth/lockout');
    const cookie = await signIn();
    const statuses: number[] = [];
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) statuses.push(await verify(cookie, '111111'));
    expect(statuses.slice(0, -1).every(s => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(await verify(cookie, '222222')).toBe(429);
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(new NextRequest('http://localhost/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }));
    expect(res.status).toBe(429);
    await resetLock();
  });
});

describe('L3: single use under simultaneous use', () => {
  it('two simultaneous uses of one recovery code: exactly one succeeds', async () => {
    const { generateRecoveryCodes, hashRecoveryCode } = await import('@/lib/auth/totp');
    const { consumeTotpRecoveryCode } = await import('@/lib/db/admin-queries');
    const { raw, hashed } = generateRecoveryCodes(1);
    await sql.run(`INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES ('rc-race', ?, ?)`, [UID, hashed[0]]);
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeTotpRecoveryCode(UID, hashRecoveryCode(raw[0]))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('two simultaneous uses of one reset token: exactly one succeeds', async () => {
    const { createPasswordResetToken, consumePasswordResetToken } = await import('@/lib/db/admin-queries');
    const token = await createPasswordResetToken(UID);
    const results = await Promise.all(Array.from({ length: 12 }, () => consumePasswordResetToken(token)));
    expect(results.filter(r => r !== null)).toHaveLength(1);
  });
});

describe('L2: S&C Board source links', () => {
  it('isWebUrl accepts http and https only', async () => {
    const { isWebUrl } = await import('@/lib/library/source-url');
    for (const ok of ['https://github.com/acme/skill', 'http://intranet.corp/x']) expect(isWebUrl(ok)).toBe(true);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'not a url', '', null, 42]) expect(isWebUrl(bad)).toBe(false);
  });

  it('saving a non-web link is refused on create and on edit; a web link and a blank are accepted', async () => {
    session = { authenticated: true, role: 'admin', email: 'lib@t.test', userId: 'u-lib' };
    const { POST } = await import('../app/api/library/route');
    const post = (body: unknown) => POST(new NextRequest('http://localhost/api/library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect((await post({ name: 'bad-skill', type: 'skill', source_url: 'javascript:alert(document.cookie)' })).status).toBe(400);
    const created = await post({ name: 'good-skill', type: 'skill', source_url: 'https://github.com/acme/good-skill' });
    expect([200, 201]).toContain(created.status);
    const entry = await created.json();
    expect(entry.source_url).toBe('https://github.com/acme/good-skill');

    const { PATCH } = await import('../app/api/library/[id]/route');
    const patch = (body: unknown) => PATCH(new NextRequest(`http://localhost/api/library/${entry.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(entry.id) }) });
    expect((await patch({ source_url: 'javascript:alert(1)' })).status).toBe(400);
    const cleared = await patch({ source_url: '' });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).source_url).toBeNull();
  });
});

describe('Board authorship for accounts whose sign-in id differs from their person record', () => {
  it('a submit records the person as author, and they get the Edit button and can edit', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name, department) VALUES ('u-pat', 'pat@t.test', 'Pat', 'Finance')`);
    await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id) VALUES ('au-pat', 'pat@t.test', 'x', 'pulse', 'Finance', 'u-pat')`);
    session = { authenticated: true, role: 'pulse', email: 'pat@t.test', userId: 'au-pat', department: 'Finance' };
    const { POST } = await import('../app/api/library/route');
    const res = await POST(new NextRequest('http://localhost/api/library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pat-skill', type: 'skill' }) }));
    const entry = await res.json();
    expect(entry.author_user_id).toBe('u-pat');

    const route = await import('../app/api/library/[id]/route');
    const ctx = { params: Promise.resolve({ id: String(entry.id) }) };
    const got = await route.GET(new NextRequest(`http://localhost/api/library/${entry.id}`), ctx);
    expect((await got.json()).is_author).toBe(true);
    const edit = await route.PATCH(new NextRequest(`http://localhost/api/library/${entry.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Mine' }) }), ctx);
    expect(edit.status).toBe(200);

    session = { authenticated: true, role: 'pulse', email: 'someone@t.test', userId: 'au-someone', department: 'Finance' };
    const other = await route.PATCH(new NextRequest(`http://localhost/api/library/${entry.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Not mine' }) }), ctx);
    expect(other.status).toBe(403);
  });
});

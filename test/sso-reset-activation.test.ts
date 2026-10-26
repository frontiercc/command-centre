// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pins the adjudicated semantics for the unauthenticated
// forgot-password -> reset-password flow against OTel auto-enrolled
// (sentinel, password_hash='__otel_pending__') accounts:
//
//   Completing an email-verified reset on a sentinel account is a DELIBERATE
//   activation — it sets a real password AND flips sso_enabled 0->1, the same
//   rule the migration-055 backfill and createAdminUser() apply. This is
//   correct, not a bug: proving control of the corporate inbox already grants
//   a password login (pre-existing behavior); SSO eligibility adds no access
//   beyond that password, since the IdP must assert the same email to use it.
//
// See app/api/admin/reset-password/route.ts (~L38) for the code-adjacent
// comment recording this same rationale, and .git/sdd/task-2-report.md for
// the corrected record (a prior report claimed this path was "unreachable
// for sentinel accounts" — false, since forgot-password has no auth gate and
// findAdminByEmail() returns sentinel rows same as any other).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let createPasswordResetToken: typeof import('@/lib/db/admin-queries').createPasswordResetToken;
let findAdminById: typeof import('@/lib/db/admin-queries').findAdminById;
let verifyPassword: typeof import('@/lib/auth/admin-auth').verifyPassword;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const adminQueries = await import('@/lib/db/admin-queries');
  createPasswordResetToken = adminQueries.createPasswordResetToken;
  findAdminById = adminQueries.findAdminById;

  const adminAuth = await import('@/lib/auth/admin-auth');
  verifyPassword = adminAuth.verifyPassword;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@sso-reset.test'`);
  await sql.exec(`DELETE FROM password_reset_tokens WHERE user_id LIKE 'sso-reset-%'`);
});

function postResetPassword(token: string, password: string) {
  const req = new NextRequest('http://localhost/api/admin/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
    headers: { 'Content-Type': 'application/json' },
  });
  return req;
}

describe('POST /api/admin/reset-password — sentinel account activation via the real route handler', () => {
  it('(a) sentinel account: completing reset sets a working password AND flips sso_enabled 0->1', async () => {
    const userId = 'sso-reset-sentinel-a';
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES (?, ?, '__otel_pending__', 'Sentinel A', 'pulse', 0)`,
      [userId, 'sentinel-a@sso-reset.test'],
    );

    // Use the exact same token-issuance helper the forgot-password route calls —
    // this proves the flow forgot-password would actually create is exploitable
    // end-to-end via the real reset-password POST handler, not a stand-in.
    const rawToken = await createPasswordResetToken(userId);

    const { POST } = await import('../app/api/admin/reset-password/route');
    const res = await POST(postResetPassword(rawToken, 'BrandNewPassw0rd!'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const updated = (await findAdminById(userId))!;
    expect(updated.password_hash).not.toBe('__otel_pending__');
    expect(verifyPassword('BrandNewPassw0rd!', updated.password_hash)).toBe(true);
    expect(updated.sso_enabled).toBe(1);
  });

  it('(b) non-sentinel account with sso_enabled=0 explicitly set: completing reset keeps sso_enabled=0', async () => {
    const userId = 'sso-reset-real-b';
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES (?, ?, 'scrypt$old$hash', 'Real B', 'admin', 0)`,
      [userId, 'real-b@sso-reset.test'],
    );

    const rawToken = await createPasswordResetToken(userId);

    const { POST } = await import('../app/api/admin/reset-password/route');
    const res = await POST(postResetPassword(rawToken, 'AnotherPassw0rd!'));
    expect(res.status).toBe(200);

    const updated = (await findAdminById(userId))!;
    expect(updated.password_hash).not.toBe('scrypt$old$hash');
    expect(verifyPassword('AnotherPassw0rd!', updated.password_hash)).toBe(true);
    expect(updated.sso_enabled).toBe(0); // must remain untouched — admin deliberately disabled SSO
  });
});

describe('POST /api/admin/forgot-password — response shape does not reveal account existence', () => {
  // isSmtpConfigured() reads config via getConfigValue(); in the fresh test DB
  // no smtpHost/smtpUser/smtpPassword/smtpFromAddress config rows exist, so the
  // route takes its `{ smtpNotConfigured: true }` early-return branch BEFORE
  // ever calling findAdminByEmail(). That branch is identical for every email,
  // so this sub-suite documents (rather than newly proves) the non-leak: the
  // account-existence check in the route body simply doesn't run under this
  // config. The route's own always-`{ ok: true }` fallthrough (when SMTP *is*
  // configured, or when sendPasswordResetEmail throws) is unchanged and is
  // the actual no-leak guarantee for a configured deployment.
  it('sentinel, real, and missing accounts all get the same response shape', async () => {
    const sentinelId = 'sso-reset-fp-sentinel';
    const realId = 'sso-reset-fp-real';
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES (?, 'fp-sentinel@sso-reset.test', '__otel_pending__', 'FP Sentinel', 'pulse', 0)`,
      [sentinelId],
    );
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES (?, 'fp-real@sso-reset.test', 'scrypt$real$hash', 'FP Real', 'admin', 1)`,
      [realId],
    );

    const { POST } = await import('../app/api/admin/forgot-password/route');

    const makeReq = (email: string) =>
      new NextRequest('http://localhost/api/admin/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
        headers: { 'Content-Type': 'application/json' },
      });

    const [sentinelRes, realRes, missingRes] = await Promise.all([
      POST(makeReq('fp-sentinel@sso-reset.test')),
      POST(makeReq('fp-real@sso-reset.test')),
      POST(makeReq('definitely-missing@sso-reset.test')),
    ]);

    expect(sentinelRes.status).toBe(realRes.status);
    expect(realRes.status).toBe(missingRes.status);

    const [sentinelBody, realBody, missingBody] = await Promise.all([
      sentinelRes.json(),
      realRes.json(),
      missingRes.json(),
    ]);

    // Same shape for all three — no field distinguishes "account exists" from "doesn't".
    expect(sentinelBody).toEqual(realBody);
    expect(realBody).toEqual(missingBody);
  });
});

describe('hasActivatedAccountOnDomain — gate on self-service activation of auto-enrolled accounts (2026-10-07)', () => {
  // Telemetry chooses an auto-enrolled account's email, so forgot-password only
  // lets one activate itself on a domain where someone is already activated.
  beforeEach(async () => {
    await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%.sso-dom.test'`);
  });

  it('is false when the only accounts on the domain are auto-enrolled', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, sso_enabled)
       VALUES ('sso-dom-1', 'pending@a.sso-dom.test', '__otel_pending__', 'pulse', 0)`,
    );
    const { hasActivatedAccountOnDomain } = await import('@/lib/db/admin-queries');
    expect(await hasActivatedAccountOnDomain('newcomer@a.sso-dom.test')).toBe(false);
  });

  it('is true once anyone on the domain has a password, matching case-insensitively', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, sso_enabled)
       VALUES ('sso-dom-2', 'Admin@B.sso-dom.test', 'scrypt$real$hash', 'admin', 0)`,
    );
    const { hasActivatedAccountOnDomain } = await import('@/lib/db/admin-queries');
    expect(await hasActivatedAccountOnDomain('newcomer@b.SSO-DOM.test')).toBe(true);
  });

  it('is true when an auto-enrolled account on the domain has had SSO turned on', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, sso_enabled)
       VALUES ('sso-dom-3', 'ssouser@c.sso-dom.test', '__otel_pending__', 'pulse', 1)`,
    );
    const { hasActivatedAccountOnDomain } = await import('@/lib/db/admin-queries');
    expect(await hasActivatedAccountOnDomain('newcomer@c.sso-dom.test')).toBe(true);
  });

  it('does not match a domain that only ends with an activated one', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, sso_enabled)
       VALUES ('sso-dom-4', 'admin@d.sso-dom.test', 'scrypt$real$hash', 'admin', 0)`,
    );
    const { hasActivatedAccountOnDomain } = await import('@/lib/db/admin-queries');
    expect(await hasActivatedAccountOnDomain('attacker@evild.sso-dom.test')).toBe(false);
    expect(await hasActivatedAccountOnDomain('no-at-sign')).toBe(false);
  });
});

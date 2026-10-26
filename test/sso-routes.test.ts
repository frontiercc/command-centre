// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The three OIDC SSO routes (start/callback/meta) against the mock
// IdP harness (test/helpers/mock-idp.ts) — exercises the full HTTP shell
// around lib/auth/oidc.ts (already covered at the unit level by
// test/oidc-lib.test.ts): 404-when-unconfigured, cookie params, session
// minting parity with password login, TOTP skip, audit rows via logAccess,
// and the ccc_sso_pending cookie being cleared on every outcome.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { startMockIdp, type MockIdp } from './helpers/mock-idp';

let sql: TestSql;
let cleanupDb: () => Promise<void>;
let idp: MockIdp;

let cfg: typeof import('@/lib/config');
let adminQueries: typeof import('@/lib/db/admin-queries');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanupDb = testDb.cleanup;

  idp = await startMockIdp();

  cfg = await import('@/lib/config');
  adminQueries = await import('@/lib/db/admin-queries');
});

afterAll(async () => {
  await idp.stop();
  await cleanupDb();
});

async function configureSso(overrides: Partial<{ enabled: boolean; issuer: string; clientId: string; clientSecret: string; redirectBase: string; label: string }> = {}) {
  const {
    enabled = true,
    issuer = idp.issuer,
    clientId = 'test-client',
    clientSecret = 'test-secret',
    redirectBase = 'http://localhost:3001',
    label = 'Mock IdP',
  } = overrides;
  await cfg.setConfigValue('ssoEnabled', enabled ? 'true' : 'false');
  await cfg.setConfigValue('ssoIssuerUrl', issuer);
  await cfg.setConfigValue('ssoClientId', clientId);
  await cfg.setConfigValue('ssoClientSecret', clientSecret);
  await cfg.setConfigValue('ssoRedirectBaseUrl', redirectBase);
  await cfg.setConfigValue('ssoProviderLabel', label);
}

async function clearSso() {
  await cfg.setConfigValue('ssoEnabled', 'false');
  await cfg.setConfigValue('ssoIssuerUrl', '');
  await cfg.setConfigValue('ssoClientId', '');
  await cfg.setConfigValue('ssoClientSecret', '');
  await cfg.setConfigValue('ssoRedirectBaseUrl', '');
  await cfg.setConfigValue('ssoProviderLabel', 'SSO');
}

// logAccess() writes through getAuditClient(), which on Postgres is the same
// database as everything else.
async function latestAuditRow(): Promise<{ actor_id: string; actor_email: string; resource: string; action: string; outcome: string; detail: string | null }> {
  const q = 'SELECT actor_id, actor_email, resource, action, outcome, detail FROM access_audit_log ORDER BY id DESC LIMIT 1';
  return (await sql.get(q)) as never;
}

/** Parses a Set-Cookie header value into { name, value, attrs (lowercased) }. */
function parseSetCookie(header: string): { name: string; value: string; maxAge?: number } {
  const [pair, ...attrs] = header.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const maxAgeAttr = attrs.find(a => a.toLowerCase().startsWith('max-age='));
  const maxAge = maxAgeAttr ? Number(maxAgeAttr.split('=')[1]) : undefined;
  return { name, value, maxAge };
}

/** Extracts ALL Set-Cookie headers (undici Headers folds multiple into one via getSetCookie when available). */
function getSetCookies(response: Response): string[] {
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') return withGetSetCookie.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

beforeEach(async () => {
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@sso-routes.test'`);
  await configureSso();
});

// ─── GET /api/auth/sso/start ────────────────────────────────────────────────

describe('GET /api/auth/sso/start', () => {
  it('404s when SSO is not configured', async () => {
    await clearSso();
    const { GET } = await import('../app/api/auth/sso/start/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost:3001/api/auth/sso/start'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('sets the ccc_sso_pending cookie and 302s to the IdP authorization endpoint', async () => {
    await configureSso();
    const { GET } = await import('../app/api/auth/sso/start/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost:3001/api/auth/sso/start'));

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    expect(new URL(location!).origin).toBe(idp.issuer);
    expect(new URL(location!).pathname).toBe('/authorize');

    const cookies = getSetCookies(res);
    const pending = cookies.map(parseSetCookie).find(c => c.name === 'ccc_sso_pending');
    expect(pending).toBeTruthy();
    expect(pending!.value.length).toBeGreaterThan(0);
    expect(pending!.maxAge).toBe(600);
    const rawHeader = cookies.find(c => c.startsWith('ccc_sso_pending='))!;
    expect(rawHeader.toLowerCase()).toContain('httponly');
    expect(rawHeader.toLowerCase()).toContain('samesite=lax');
  });
});

// ─── GET /api/auth/sso/callback ─────────────────────────────────────────────

describe('GET /api/auth/sso/callback', () => {
  async function startFlow() {
    const { GET: start } = await import('../app/api/auth/sso/start/route');
    const { NextRequest } = await import('next/server');
    const startRes = await start(new NextRequest('http://localhost:3001/api/auth/sso/start'));
    const authorizeUrl = new URL(startRes.headers.get('location')!);
    const pendingCookie = getSetCookies(startRes).map(parseSetCookie).find(c => c.name === 'ccc_sso_pending')!.value;
    const state = authorizeUrl.searchParams.get('state')!;
    const nonce = authorizeUrl.searchParams.get('nonce')!;
    return { pendingCookie, state, nonce };
  }

  async function callCallback(query: Record<string, string>, pendingCookie: string | undefined) {
    const { GET } = await import('../app/api/auth/sso/callback/route');
    const { NextRequest } = await import('next/server');
    const url = new URL('http://localhost:3001/api/auth/sso/callback');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = new Headers();
    if (pendingCookie !== undefined) headers.set('cookie', `ccc_sso_pending=${pendingCookie}`);
    return GET(new NextRequest(url, { headers }));
  }

  it('404s when SSO is not configured', async () => {
    await clearSso();
    const res = await callCallback({ code: 'x', state: 'y' }, undefined);
    expect(res.status).toBe(404);
  });

  describe('happy path', () => {
    it('mints a real session (accepted by findValidSession), skips TOTP, clears the pending cookie, redirects to /, and audits success', async () => {
      await adminQueries.createAdminUser({ email: 'happy@sso-routes.test', passwordHash: '__otel_pending__', displayName: 'Happy Route', role: 'viewer' });

      const { pendingCookie, state, nonce } = await startFlow();
      const code = idp.issueCode({ email: 'happy@sso-routes.test', email_verified: true, nonce });

      const res = await callCallback({ code, state }, pendingCookie);

      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/');

      // The real session cookie is set — a protected route's own session
      // lookup (findValidSession, the same call getAdminSession makes) must
      // accept it, proving this is byte-identical to password login's mint.
      const cookies = getSetCookies(res).map(parseSetCookie);
      const session = cookies.find(c => c.name === 'ccc_session');
      expect(session).toBeTruthy();
      const valid = await adminQueries.findValidSession(session!.value);
      expect(valid).toBeTruthy();
      expect(valid!.user.email).toBe('happy@sso-routes.test');

      // Pending cookie cleared on success.
      const pendingAfter = cookies.find(c => c.name === 'ccc_sso_pending');
      expect(pendingAfter).toBeTruthy();
      expect(pendingAfter!.maxAge).toBe(0);

      const audit = await latestAuditRow();
      expect(audit.resource).toBe('auth');
      expect(audit.action).toBe('SSO_LOGIN');
      expect(audit.outcome).toBe('success');
      expect(audit.actor_email).toBe('happy@sso-routes.test');
    });

    it('a TOTP-enrolled account still logs straight in via SSO with a full session (no MFA pending cookie)', async () => {
      const user = await adminQueries.createAdminUser({ email: 'totp@sso-routes.test', passwordHash: '__otel_pending__', displayName: 'Totp Route', role: 'viewer' });
      await sql.run(`UPDATE admin_users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?`, [user.id]);
      expect((await adminQueries.getTotpStatus(user.id)).enabled).toBe(true);

      const { pendingCookie, state, nonce } = await startFlow();
      const code = idp.issueCode({ email: 'totp@sso-routes.test', email_verified: true, nonce });
      const res = await callCallback({ code, state }, pendingCookie);

      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/');

      const cookies = getSetCookies(res).map(parseSetCookie);
      expect(cookies.find(c => c.name === 'ccc_mfa_pending')).toBeUndefined();
      const session = cookies.find(c => c.name === 'ccc_session');
      expect(session).toBeTruthy();
      const valid = await adminQueries.findValidSession(session!.value);
      expect(valid).toBeTruthy();
      expect(valid!.user.email).toBe('totp@sso-routes.test');
    });
  });

  describe('refusal matrix', () => {
    const cases: Array<{
      name: string;
      reason: string;
      setup: () => Promise<{ pendingCookie: string | undefined; query: Record<string, string> }>;
    }> = [
      {
        name: 'email_unverified',
        reason: 'email_unverified',
        setup: async () => {
          await adminQueries.createAdminUser({ email: 'unverified@sso-routes.test', passwordHash: '__otel_pending__', role: 'viewer' });
          const { pendingCookie, state, nonce } = await startFlow();
          const code = idp.issueCode({ email: 'unverified@sso-routes.test', email_verified: false, nonce });
          return { pendingCookie, query: { code, state } };
        },
      },
      {
        name: 'unknown_account',
        reason: 'unknown_account',
        setup: async () => {
          const { pendingCookie, state, nonce } = await startFlow();
          const code = idp.issueCode({ email: 'nobody@sso-routes.test', email_verified: true, nonce });
          return { pendingCookie, query: { code, state } };
        },
      },
      {
        name: 'sso_not_enabled',
        reason: 'sso_not_enabled',
        setup: async () => {
          await sql.run(
            `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
             VALUES ('dormant-route', 'dormant@sso-routes.test', '__otel_pending__', 'Dormant', 'pulse', 0)`,
          );
          const { pendingCookie, state, nonce } = await startFlow();
          const code = idp.issueCode({ email: 'dormant@sso-routes.test', email_verified: true, nonce });
          return { pendingCookie, query: { code, state } };
        },
      },
      {
        name: 'state_mismatch (missing pending cookie)',
        reason: 'state_mismatch',
        setup: async () => {
          const { state, nonce } = await startFlow();
          const code = idp.issueCode({ email: 'someone@sso-routes.test', email_verified: true, nonce });
          return { pendingCookie: undefined, query: { code, state } };
        },
      },
      {
        name: 'token_invalid (wrong nonce)',
        reason: 'token_invalid',
        setup: async () => {
          await adminQueries.createAdminUser({ email: 'wrongnonce@sso-routes.test', passwordHash: '__otel_pending__', role: 'viewer' });
          const { pendingCookie, state } = await startFlow();
          const code = idp.issueCode({ email: 'wrongnonce@sso-routes.test', email_verified: true, nonce: 'attacker-nonce' });
          return { pendingCookie, query: { code, state } };
        },
      },
    ];

    for (const { name, reason, setup } of cases) {
      it(`${name}: redirects to /admin/login?sso_error=${reason}, clears pending cookie, audits failure`, async () => {
        const { pendingCookie, query } = await setup();
        const res = await callCallback(query, pendingCookie);

        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe('/admin/login');
        expect(location.searchParams.get('sso_error')).toBe(reason);

        const cookies = getSetCookies(res).map(parseSetCookie);
        const pendingAfter = cookies.find(c => c.name === 'ccc_sso_pending');
        expect(pendingAfter).toBeTruthy();
        expect(pendingAfter!.maxAge).toBe(0);

        // No session cookie on a refusal.
        expect(cookies.find(c => c.name === 'ccc_session')).toBeUndefined();

        const audit = await latestAuditRow();
        expect(audit.resource).toBe('auth');
        expect(audit.action).toBe('SSO_LOGIN');
        expect(audit.outcome).toBe('failure');
        expect(audit.detail).toBe(reason);
      });
    }
  });
});

// ─── GET /api/auth/sso/meta ─────────────────────────────────────────────────

describe('GET /api/auth/sso/meta', () => {
  it('returns {enabled: true, label} and NOTHING else when configured', async () => {
    await configureSso({ label: 'Okta' });
    const { GET } = await import('../app/api/auth/sso/meta/route');
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ enabled: true, label: 'Okta' });
  });

  it('returns {enabled: false, label} when not configured — never issuer/client values', async () => {
    await clearSso();
    const { GET } = await import('../app/api/auth/sso/meta/route');
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ enabled: false, label: 'SSO' });
    expect(JSON.stringify(body)).not.toContain('issuer');
    expect(JSON.stringify(body)).not.toContain('client');
  });

  it('when disabled, always reports the default label "SSO" — never a previously-configured custom label', async () => {
    // Configure SSO with a custom label, then disable it WITHOUT resetting
    // ssoProviderLabel (await clearSso() resets the label too, which would mask
    // this leak). enabled: false must force label back to the default,
    // never echo whatever an admin typed in before disabling.
    await configureSso({ label: 'Acme Okta' });
    await cfg.setConfigValue('ssoEnabled', 'false');
    const { GET } = await import('../app/api/auth/sso/meta/route');
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ enabled: false, label: 'SSO' });
  });
});

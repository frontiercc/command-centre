// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/auth/oidc.ts — the core OIDC SSO module. Exercises the full
// matrix against the in-process mock IdP
// (test/helpers/mock-idp.ts): happy path, every refusal reason, and
// getOidcSettings' null-unless-fully-configured gate.
//
// admin_users has NO deactivation column (verified: grepped all migrations —
// 036_user_deactivation.sql adds deactivated_at to the `users` [monitored/
// Pulse] table, not `admin_users` [login accounts]; `locked_until` from
// migration 052 is a distinct concept — temporary login-throttle lockout, not
// account deactivation). The gate is therefore existence +
// sso_enabled only — there is no 'account_disabled' path to exercise today.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { startMockIdp, type MockIdp } from './helpers/mock-idp';

let sql: TestSql;
let cleanupDb: () => Promise<void>;
let idp: MockIdp;

let cfg: typeof import('@/lib/config');
let oidc: typeof import('@/lib/auth/oidc');
let adminQueries: typeof import('@/lib/db/admin-queries');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanupDb = testDb.cleanup;

  idp = await startMockIdp();

  cfg = await import('@/lib/config');
  oidc = await import('@/lib/auth/oidc');
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

beforeEach(async () => {
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@oidc-lib.test'`);
  await configureSso();
});

// ─── getOidcSettings ────────────────────────────────────────────────────────

describe('getOidcSettings', () => {
  it('returns the full settings object when ssoEnabled + all four keys are set', async () => {
    await configureSso({ issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'secret', redirectBase: 'https://ccc.example.com', label: 'Google' });
    const settings = await oidc.getOidcSettings();
    expect(settings).toEqual({
      issuerUrl: 'https://accounts.google.com',
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'https://ccc.example.com/api/auth/sso/callback',
      providerLabel: 'Google',
    });
  });

  it('returns null when ssoEnabled is false', async () => {
    await configureSso({ enabled: false });
    expect(await oidc.getOidcSettings()).toBeNull();
  });

  it('returns null when issuer is missing', async () => {
    await configureSso();
    await cfg.setConfigValue('ssoIssuerUrl', '');
    expect(await oidc.getOidcSettings()).toBeNull();
  });

  it('returns null when clientId is missing', async () => {
    await configureSso();
    await cfg.setConfigValue('ssoClientId', '');
    expect(await oidc.getOidcSettings()).toBeNull();
  });

  it('returns null when clientSecret is missing', async () => {
    await configureSso();
    await cfg.setConfigValue('ssoClientSecret', '');
    expect(await oidc.getOidcSettings()).toBeNull();
  });

  it('returns null when redirectBaseUrl is missing', async () => {
    await configureSso();
    await cfg.setConfigValue('ssoRedirectBaseUrl', '');
    expect(await oidc.getOidcSettings()).toBeNull();
  });

  it('returns null when nothing at all is configured (fresh install)', async () => {
    await clearSso();
    expect(await oidc.getOidcSettings()).toBeNull();
  });
});

// ─── beginSsoLogin ──────────────────────────────────────────────────────────

describe('beginSsoLogin', () => {
  it('discovers the mock issuer and returns a redirect URL with PKCE + state + nonce', async () => {
    await configureSso();
    const start = await oidc.beginSsoLogin();

    const url = new URL(start.redirectUrl);
    expect(url.origin).toBe(idp.issuer);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/auth/sso/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(typeof start.pendingCookie).toBe('string');
    expect(start.pendingCookie.length).toBeGreaterThan(0);
  });

  it('produces a pendingCookie that round-trips a distinct state/nonce/verifier per call', async () => {
    await configureSso();
    const a = await oidc.beginSsoLogin();
    const b = await oidc.beginSsoLogin();
    const stateA = new URL(a.redirectUrl).searchParams.get('state');
    const stateB = new URL(b.redirectUrl).searchParams.get('state');
    expect(stateA).not.toBe(stateB);
    expect(a.pendingCookie).not.toBe(b.pendingCookie);
  });
});

// ─── completeSsoLogin — happy path ──────────────────────────────────────────

describe('completeSsoLogin — happy path', () => {
  it('returns ok:true with the account when everything checks out', async () => {
    await adminQueries.createAdminUser({
      email: 'happy@oidc-lib.test',
      passwordHash: '__otel_pending__',
      displayName: 'Happy Path',
      role: 'viewer',
    });
    // Deliberately provisioned via createAdminUser -> sso_enabled=1 already;
    // this fixture proves the "OTel sentinel + explicit SSO opt-in" case too.

    await configureSso();
    const start = await oidc.beginSsoLogin();
    const url = new URL(start.redirectUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;

    const code = idp.issueCode({ email: 'Happy@OIDC-LIB.test', email_verified: true, name: 'Happy Path', nonce });

    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.account.email).toBe('happy@oidc-lib.test');
      expect(result.account.role).toBe('viewer');
      expect(typeof result.account.id).toBe('string');
    }
  });
});

// ─── completeSsoLogin — refusal matrix ─────────────────────────────────────

describe('completeSsoLogin — refusal matrix', () => {
  async function beginAndIssueCode(claimOverrides: Partial<{ email: string; email_verified: boolean | null; name: string; extra: Record<string, unknown> }> = {}, nonceOverride?: string) {
    const start = await oidc.beginSsoLogin();
    const url = new URL(start.redirectUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const code = idp.issueCode({
      email: claimOverrides.email ?? 'someone@oidc-lib.test',
      email_verified: claimOverrides.email_verified === undefined ? true : claimOverrides.email_verified,
      name: claimOverrides.name,
      nonce: nonceOverride ?? nonce,
      extra: claimOverrides.extra,
    });
    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    return { start, callbackUrl };
  }

  it('email_unverified: unverified email claim is refused before any account lookup', async () => {
    await adminQueries.createAdminUser({ email: 'unverified@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'unverified@oidc-lib.test', email_verified: false });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'email_unverified' });
  });

  it('xms_edov from an issuer that is not Microsoft does not verify the email', async () => {
    await adminQueries.createAdminUser({ email: 'entra@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'entra@oidc-lib.test', email_verified: null, extra: { xms_edov: true } });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'email_unverified' });
  });

  it('email_unverified: no email_verified claim and no xms_edov is refused', async () => {
    await adminQueries.createAdminUser({ email: 'noclaim@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'noclaim@oidc-lib.test', email_verified: null });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'email_unverified' });
  });

  it('unknown_account: verified email with no matching admin_users row is refused', async () => {
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'nobody-here@oidc-lib.test', email_verified: true });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'unknown_account' });
  });

  it('sso_not_enabled: account exists but sso_enabled=0 (the OTel-dormant fixture) is refused', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES ('dormant1', 'dormant@oidc-lib.test', '__otel_pending__', 'Dormant One', 'pulse', 0)`,
    );

    const { start, callbackUrl } = await beginAndIssueCode({ email: 'dormant@oidc-lib.test', email_verified: true });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'sso_not_enabled' });
  });

  it('email match is case-insensitive (IdP-cased claim vs lowercased admin_users row)', async () => {
    await adminQueries.createAdminUser({ email: 'mixedcase@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'MixedCase@OIDC-Lib.TEST', email_verified: true });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result.ok).toBe(true);
  });

  it('state_mismatch: tampered state cookie (pendingCookie does not match callback state) is refused', async () => {
    await adminQueries.createAdminUser({ email: 'tampered@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });

    const startA = await oidc.beginSsoLogin();
    const startB = await oidc.beginSsoLogin();
    const urlB = new URL(startB.redirectUrl);
    const nonceB = urlB.searchParams.get('nonce')!;
    const stateB = urlB.searchParams.get('state')!;

    const code = idp.issueCode({ email: 'tampered@oidc-lib.test', email_verified: true, nonce: nonceB });
    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', stateB);

    // Using startA's pendingCookie (sealed state/verifier from a DIFFERENT
    // beginSsoLogin call) against a callback carrying startB's state/code.
    const result = await oidc.completeSsoLogin(callbackUrl, startA.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('state_mismatch: missing pendingCookie is refused', async () => {
    const { callbackUrl } = await beginAndIssueCode({ email: 'someone@oidc-lib.test' });
    const result = await oidc.completeSsoLogin(callbackUrl, undefined);
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('state_mismatch: garbage/corrupt pendingCookie is refused', async () => {
    const { callbackUrl } = await beginAndIssueCode({ email: 'someone@oidc-lib.test' });
    const result = await oidc.completeSsoLogin(callbackUrl, 'not-a-real-sealed-token');
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('state_mismatch: expired pending cookie (>10 min old) is refused', async () => {
    await adminQueries.createAdminUser({ email: 'expired@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });

    const start = await oidc.beginSsoLogin();
    const url = new URL(start.redirectUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const code = idp.issueCode({ email: 'expired@oidc-lib.test', email_verified: true, nonce });
    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    // Re-seal an identical-shaped payload but already expired, using the same
    // primitive oidc.ts uses (sealPendingPayload from lib/auth/totp.ts) with a
    // negative TTL so `exp` is already in the past.
    const { sealPendingPayload } = await import('@/lib/auth/totp');
    const expiredCookie = sealPendingPayload('sso', {
      state,
      nonce,
      // The verifier isn't recoverable from the redirect URL (never exposed),
      // so we can't reconstruct a byte-identical original cookie — but since
      // expiry is checked first this doesn't matter for this assertion.
      verifier: 'irrelevant-because-expired',
    }, -1000);

    const result = await oidc.completeSsoLogin(callbackUrl, expiredCookie);
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('token_invalid: wrong nonce (ID-token substitution) is refused', async () => {
    await adminQueries.createAdminUser({ email: 'wrongnonce@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });

    const start = await oidc.beginSsoLogin();
    const url = new URL(start.redirectUrl);
    const state = url.searchParams.get('state')!;

    // IdP signs the ID token against a nonce that does NOT match the one
    // sealed in start.pendingCookie.
    const code = idp.issueCode({ email: 'wrongnonce@oidc-lib.test', email_verified: true, nonce: 'attacker-supplied-nonce' });
    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result).toEqual({ ok: false, reason: 'token_invalid' });
  });

  it('token_invalid: replayed authorization code (second grant with the same code) is refused', async () => {
    await adminQueries.createAdminUser({ email: 'replay@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });

    const start = await oidc.beginSsoLogin();
    const url = new URL(start.redirectUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const code = idp.issueCode({ email: 'replay@oidc-lib.test', email_verified: true, nonce });

    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    const first = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(first.ok).toBe(true);

    // Second completion attempt reuses the SAME authorization code. The mock
    // IdP deletes codes on first use (test/helpers/mock-idp.ts `pendingCodes.delete`),
    // so the token endpoint returns invalid_grant on replay — this must map to
    // token_invalid, not silently re-succeed.
    const replay = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(replay).toEqual({ ok: false, reason: 'token_invalid' });
  });

  it('getOidcSettings null (SSO disabled) causes completeSsoLogin to refuse rather than throw', async () => {
    await adminQueries.createAdminUser({ email: 'disabledcfg@oidc-lib.test', passwordHash: '__otel_pending__', role: 'viewer' });
    const { start, callbackUrl } = await beginAndIssueCode({ email: 'disabledcfg@oidc-lib.test' });

    await configureSso({ enabled: false });

    const result = await oidc.completeSsoLogin(callbackUrl, start.pendingCookie);
    expect(result.ok).toBe(false);
  });
});

// ─── Discovery cache invalidation ───────────────────────────────────────────

describe('discovery cache', () => {
  it('recovers after a discovery failure once config points at a reachable issuer again', async () => {
    // Point at an unreachable issuer first — discovery must fail without
    // poisoning the module-level cache for subsequent good configs.
    await configureSso({ issuer: 'http://127.0.0.1:1' });
    await expect(oidc.beginSsoLogin()).rejects.toBeTruthy();

    await configureSso({ issuer: idp.issuer });
    const start = await oidc.beginSsoLogin();
    expect(new URL(start.redirectUrl).origin).toBe(idp.issuer);
  });
});

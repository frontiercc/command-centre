// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the six OIDC SSO config keys: ssoEnabled, ssoIssuerUrl, ssoClientId, ssoClientSecret, ssoProviderLabel,
 * ssoRedirectBaseUrl.
 *
 * ssoClientSecret is SENSITIVE — same pattern as digestSlackWebhookUrl
 * (test/config-digest-webhook-sensitive.test.ts): it must never come back raw from the
 * generic GET /api/config route, and must round-trip correctly through lib/config.ts's
 * getConfigValue/setConfigValue. Both registries — app/api/config/route.ts SENSITIVE_KEYS
 * and lib/config.ts SENSITIVE_KEYS — must include the key for this to hold.
 *
 * Five of the six keys are clearable back to their documented default via POST /api/config
 * with an empty string. ssoClientSecret is the exception:
 * as a registered secret (lib/config-secrets.ts) it is Remove-only — blanking it via POST
 * /api/config is dropped and reported `{ reason: 'blank-not-clearable' }`; DELETE
 * /api/config/secret is the only path that clears it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

const SECRET = 'super-secret-client-secret-value-123456';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

// See config-digest-webhook-sensitive.test.ts: app/api/config/route.ts calls logAccess()
// on every GET/POST, which opens a singleton audit client that outlives the test database.
// Mock it out — audit logging isn't under test here.
vi.mock('@/lib/audit/log', () => ({
  logAccess: vi.fn(),
}));

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/config', { method: 'GET' });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SSO config keys', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  describe('defaults', () => {
    it('ssoEnabled defaults to false', async () => {
      expect((await cfg.getAllConfig()).ssoEnabled).toBe(false);
    });

    it('ssoProviderLabel defaults to "SSO"', async () => {
      expect((await cfg.getAllConfig()).ssoProviderLabel).toBe('SSO');
    });

    it('ssoIssuerUrl, ssoClientId, ssoClientSecret, ssoRedirectBaseUrl default to empty string', async () => {
      const all = (await cfg.getAllConfig());
      expect(all.ssoIssuerUrl).toBe('');
      expect(all.ssoClientId).toBe('');
      expect(all.ssoClientSecret).toBe('');
      expect(all.ssoRedirectBaseUrl).toBe('');
    });
  });

  describe('round-trip via getConfigValue/setConfigValue', () => {
    it('ssoEnabled round-trips', async () => {
      await cfg.setConfigValue('ssoEnabled', 'true');
      expect(await cfg.getConfigValue('ssoEnabled')).toBe('true');
      expect((await cfg.getAllConfig()).ssoEnabled).toBe(true);
    });

    it('ssoIssuerUrl round-trips', async () => {
      await cfg.setConfigValue('ssoIssuerUrl', 'https://accounts.google.com');
      expect(await cfg.getConfigValue('ssoIssuerUrl')).toBe('https://accounts.google.com');
      expect((await cfg.getAllConfig()).ssoIssuerUrl).toBe('https://accounts.google.com');
    });

    it('ssoClientId round-trips', async () => {
      await cfg.setConfigValue('ssoClientId', 'client-abc-123');
      expect(await cfg.getConfigValue('ssoClientId')).toBe('client-abc-123');
      expect((await cfg.getAllConfig()).ssoClientId).toBe('client-abc-123');
    });

    it('ssoClientSecret round-trips (lib/config.ts registry)', async () => {
      await cfg.setConfigValue('ssoClientSecret', SECRET);
      expect(await cfg.getConfigValue('ssoClientSecret')).toBe(SECRET);
      expect((await cfg.getAllConfig()).ssoClientSecret).toBe(SECRET);
    });

    it('ssoProviderLabel round-trips', async () => {
      await cfg.setConfigValue('ssoProviderLabel', 'Okta');
      expect(await cfg.getConfigValue('ssoProviderLabel')).toBe('Okta');
      expect((await cfg.getAllConfig()).ssoProviderLabel).toBe('Okta');
    });

    it('ssoRedirectBaseUrl round-trips', async () => {
      await cfg.setConfigValue('ssoRedirectBaseUrl', 'https://ccc.example.com');
      expect(await cfg.getConfigValue('ssoRedirectBaseUrl')).toBe('https://ccc.example.com');
      expect((await cfg.getAllConfig()).ssoRedirectBaseUrl).toBe('https://ccc.example.com');
    });
  });

  describe('ssoClientSecret masking (GET /api/config)', () => {
    it('is not returned raw by GET /api/config — masked like other secrets', async () => {
      await cfg.setConfigValue('ssoClientSecret', SECRET);

      const { GET } = await import('../app/api/config/route');
      const res = await GET(makeGetRequest());
      const data = await res.json();

      expect(data.ssoClientSecret).not.toBe(SECRET);
      expect(data.ssoClientSecret).toContain('••••••••');
    });

    it('non-sensitive SSO keys are returned unmasked by GET /api/config', async () => {
      await cfg.setConfigValue('ssoEnabled', 'true');
      await cfg.setConfigValue('ssoIssuerUrl', 'https://accounts.google.com');
      await cfg.setConfigValue('ssoClientId', 'client-abc-123');
      await cfg.setConfigValue('ssoProviderLabel', 'Okta');
      await cfg.setConfigValue('ssoRedirectBaseUrl', 'https://ccc.example.com');

      const { GET } = await import('../app/api/config/route');
      const res = await GET(makeGetRequest());
      const data = await res.json();

      expect(data.ssoEnabled).toBe(true);
      expect(data.ssoIssuerUrl).toBe('https://accounts.google.com');
      expect(data.ssoClientId).toBe('client-abc-123');
      expect(data.ssoProviderLabel).toBe('Okta');
      expect(data.ssoRedirectBaseUrl).toBe('https://ccc.example.com');
    });

    it('does not re-save the masked placeholder as a literal value (POST /api/config)', async () => {
      await cfg.setConfigValue('ssoClientSecret', SECRET);

      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoClientSecret: 'super-s••••••••' }));
      expect(res.status).toBe(200);

      // Original value untouched — masked placeholder must never overwrite the real secret.
      expect(await cfg.getConfigValue('ssoClientSecret')).toBe(SECRET);
    });
  });

  describe('POST /api/config write + clear', () => {
    it('writes all six keys via POST /api/config', async () => {
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({
        ssoEnabled: 'true',
        ssoIssuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
        ssoClientId: 'ms-client-id',
        ssoClientSecret: 'ms-client-secret-value',
        ssoProviderLabel: 'Microsoft',
        ssoRedirectBaseUrl: 'http://localhost:3001',
      }));
      expect(res.status).toBe(200);

      const all = (await cfg.getAllConfig());
      expect(all.ssoEnabled).toBe(true);
      expect(all.ssoIssuerUrl).toBe('https://login.microsoftonline.com/tenant/v2.0');
      expect(all.ssoClientId).toBe('ms-client-id');
      expect(all.ssoClientSecret).toBe('ms-client-secret-value');
      expect(all.ssoProviderLabel).toBe('Microsoft');
      expect(all.ssoRedirectBaseUrl).toBe('http://localhost:3001');
    });

    it('clearing ssoEnabled resets to default "false"', async () => {
      await cfg.setConfigValue('ssoEnabled', 'true');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoEnabled: 'false' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).ssoEnabled).toBe(false);
    });

    it('clearing ssoIssuerUrl resets to default ""', async () => {
      await cfg.setConfigValue('ssoIssuerUrl', 'https://accounts.google.com');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoIssuerUrl: '' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).ssoIssuerUrl).toBe('');
    });

    it('clearing ssoClientId resets to default ""', async () => {
      await cfg.setConfigValue('ssoClientId', 'client-abc-123');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoClientId: '' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).ssoClientId).toBe('');
    });

    it('blanking ssoClientSecret via POST /api/config is Remove-only — dropped, reported, value survives', async () => {
      // ssoClientSecret is a registered secret (lib/config-secrets.ts)
      // made all registry secrets Remove-only. DELETE /api/config/secret is the only clear path.
      await cfg.setConfigValue('ssoClientSecret', SECRET);
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoClientSecret: '' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ignored).toEqual([{ key: 'ssoClientSecret', reason: 'blank-not-clearable' }]);
      expect((await cfg.getAllConfig()).ssoClientSecret).toBe(SECRET);
    });

    it('clearing ssoProviderLabel resets to default "SSO"', async () => {
      await cfg.setConfigValue('ssoProviderLabel', 'Okta');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoProviderLabel: '' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).ssoProviderLabel).toBe('SSO');
    });

    it('clearing ssoRedirectBaseUrl resets to default ""', async () => {
      await cfg.setConfigValue('ssoRedirectBaseUrl', 'https://ccc.example.com');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ ssoRedirectBaseUrl: '' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).ssoRedirectBaseUrl).toBe('');
    });
  });
});

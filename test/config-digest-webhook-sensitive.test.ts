// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for digestSlackWebhookUrl's sensitive-key handling.
 *
 * The Slack webhook grants posting rights into the customer's workspace, so it
 * must (1) never come back raw from the generic GET /api/config route, and
 * (2) round-trip correctly through lib/config.ts's getConfigValue/setConfigValue
 * (which route sensitive keys through decryptSecret() on read). Both registries
 * — app/api/config/route.ts SENSITIVE_KEYS and lib/config.ts SENSITIVE_KEYS —
 * must include the key for this to hold.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

// app/api/config/route.ts calls logAccess() on every GET/POST. Mock it out —
// same approach as test/audit-log.test.ts — since audit logging isn't what
// this test is verifying.
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

describe('digestSlackWebhookUrl sensitive-key handling', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  it('round-trips transparently through getConfigValue/setConfigValue (lib/config.ts registry)', async () => {
    await cfg.setConfigValue('digestSlackWebhookUrl', WEBHOOK);
    expect(await cfg.getConfigValue('digestSlackWebhookUrl')).toBe(WEBHOOK);
    expect((await cfg.getAllConfig()).digestSlackWebhookUrl).toBe(WEBHOOK);
  });

  it('is not returned raw by GET /api/config — masked like other secrets', async () => {
    await cfg.setConfigValue('digestSlackWebhookUrl', WEBHOOK);

    const { GET } = await import('../app/api/config/route');
    const res = await GET(makeGetRequest());
    const data = await res.json();

    expect(data.digestSlackWebhookUrl).not.toBe(WEBHOOK);
    expect(data.digestSlackWebhookUrl).toContain('••••••••');
  });

  it('digest admin GET still returns the masked form (app/api/admin/digest/route.ts)', async () => {
    await cfg.setConfigValue('digestSlackWebhookUrl', WEBHOOK);

    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeGetRequest());
    const data = await res.json();

    expect(data.digestSlackWebhookUrl).not.toBe(WEBHOOK);
    expect(data.digestSlackWebhookUrl).toContain('••••••••');
    expect(data.channels.slack).toBe(true);
  });

  it('PUT round-trip via app/api/admin/digest/route.ts still saves and reads back correctly', async () => {
    const newWebhook = 'https://hooks.slack.com/services/T111/B111/YYYYYYYYYYYYYYYYYYYYYYYY';
    const { PUT } = await import('../app/api/admin/digest/route');
    const putRes = await PUT(new NextRequest('http://localhost/api/admin/digest', {
      method: 'PUT',
      body: JSON.stringify({ digestSlackWebhookUrl: newWebhook }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(putRes.status).toBe(200);

    // Underlying stored value round-trips through the real (unmocked) lib/config.
    expect(await cfg.getConfigValue('digestSlackWebhookUrl')).toBe(newWebhook);

    const { GET } = await import('../app/api/admin/digest/route');
    const getRes = await GET(makeGetRequest());
    const data = await getRes.json();
    expect(data.digestSlackWebhookUrl).toContain('••••••••');
  });

  it('does not re-save the masked placeholder as a literal value (POST /api/config)', async () => {
    await cfg.setConfigValue('digestSlackWebhookUrl', WEBHOOK);

    const { POST } = await import('../app/api/config/route');
    const res = await POST(makePostRequest({ digestSlackWebhookUrl: 'https://hoo••••••••' }));
    expect(res.status).toBe(200);

    // Original value untouched — masked placeholder must never overwrite the real secret.
    expect(await cfg.getConfigValue('digestSlackWebhookUrl')).toBe(WEBHOOK);
  });

  it('a blank webhook via PUT /api/admin/digest is a no-op — Remove-only holds on this write path too', async () => {
    await cfg.setConfigValue('digestSlackWebhookUrl', WEBHOOK);

    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(new NextRequest('http://localhost/api/admin/digest', {
      method: 'PUT',
      body: JSON.stringify({ digestSlackWebhookUrl: '' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(res.status).toBe(200);

    // Blanking the field + Save must never clear a stored secret — the audited
    // DELETE /api/config/secret is the only clear path.
    expect(await cfg.getConfigValue('digestSlackWebhookUrl')).toBe(WEBHOOK);
  });
});

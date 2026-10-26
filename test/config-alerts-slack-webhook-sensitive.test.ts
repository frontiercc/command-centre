// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

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

describe('alertsSlackWebhookUrl sensitive-key handling', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  it('round-trips transparently through getConfigValue/setConfigValue', async () => {
    await cfg.setConfigValue('alertsSlackWebhookUrl', WEBHOOK);
    expect(await cfg.getConfigValue('alertsSlackWebhookUrl')).toBe(WEBHOOK);
    expect((await cfg.getAllConfig()).alertsSlackWebhookUrl).toBe(WEBHOOK);
  });

  it('is not returned raw by GET /api/config — masked like other secrets', async () => {
    await cfg.setConfigValue('alertsSlackWebhookUrl', WEBHOOK);

    const { GET } = await import('../app/api/config/route');
    const res = await GET(makeGetRequest());
    const data = await res.json();

    expect(data.alertsSlackWebhookUrl).not.toBe(WEBHOOK);
    expect(data.alertsSlackWebhookUrl).toContain('••••••••');
  });

  it('does not re-save the masked placeholder as a literal value', async () => {
    await cfg.setConfigValue('alertsSlackWebhookUrl', WEBHOOK);

    const { POST } = await import('../app/api/config/route');
    const res = await POST(makePostRequest({ alertsSlackWebhookUrl: 'https://hoo••••••••' }));
    expect(res.status).toBe(200);
    expect(await cfg.getConfigValue('alertsSlackWebhookUrl')).toBe(WEBHOOK);
  });

  it('a blank webhook via POST /api/config is a no-op — Remove-only holds', async () => {
    await cfg.setConfigValue('alertsSlackWebhookUrl', WEBHOOK);

    const { POST } = await import('../app/api/config/route');
    const res = await POST(makePostRequest({ alertsSlackWebhookUrl: '' }));
    expect(res.status).toBe(200);
    expect(await cfg.getConfigValue('alertsSlackWebhookUrl')).toBe(WEBHOOK);
  });

  it('rejects a non-https webhook URL with a 400', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(makePostRequest({ alertsSlackWebhookUrl: 'http://hooks.slack.com/services/x' }));
    expect(res.status).toBe(400);
  });

  it('DELETE /api/config/secret removes it', async () => {
    await cfg.setConfigValue('alertsSlackWebhookUrl', WEBHOOK);

    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(new NextRequest('http://localhost/api/config/secret', {
      method: 'DELETE',
      body: JSON.stringify({ key: 'alertsSlackWebhookUrl' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    expect(await cfg.getConfigValue('alertsSlackWebhookUrl')).toBe('');
  });
});

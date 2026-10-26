// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// An earlier incident: blanking a key field + Save silently no-opped while
// the UI said "Saved". The route now reports every submitted-but-ignored field.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/config save honesty', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  it('reports a blanked non-clearable key as ignored', async () => {
    await cfg.setConfigValue('complianceAccessKey', 'sk-ant-api01-real');
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ complianceAccessKey: '' }));
    const body = await res.json();
    expect(body.ignored).toEqual([{ key: 'complianceAccessKey', reason: 'blank-not-clearable' }]);
    expect(await cfg.getConfigValue('complianceAccessKey')).toBe('sk-ant-api01-real');
  });

  it('reports a blanked ssoClientSecret as ignored (all registry secrets are Remove-only)', async () => {
    // ssoClientSecret, digestSlackWebhookUrl, and dxApiKey
    // were dropped from clearableKeys so every lib/config-secrets.ts registry secret is
    // Remove-only — DELETE /api/config/secret is the only path that clears them.
    await cfg.setConfigValue('ssoClientSecret', 'oidc-secret-real');
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ ssoClientSecret: '' }));
    const body = await res.json();
    expect(body.ignored).toEqual([{ key: 'ssoClientSecret', reason: 'blank-not-clearable' }]);
    expect(await cfg.getConfigValue('ssoClientSecret')).toBe('oidc-secret-real');
  });

  it('reports a masked round-trip as ignored', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ complianceAccessKey: 'sk-ant-••••••••' }));
    const body = await res.json();
    expect(body.ignored).toEqual([{ key: 'complianceAccessKey', reason: 'masked' }]);
  });

  it('clearable blanks still save and are NOT reported', async () => {
    await cfg.setConfigValue('dataProtectionOfficer', 'Jane');
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ dataProtectionOfficer: '' }));
    const body = await res.json();
    expect(body.ignored).toEqual([]);
    expect(await cfg.getConfigValue('dataProtectionOfficer')).toBe('');
  });

  it('choosing "follow Core AI" for personal briefings saves the blank (it is clearable)', async () => {
    await cfg.setConfigValue('pulseUserBriefingModel', 'claude-sonnet-5');
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ pulseUserBriefingModel: '' }));
    const body = await res.json();
    expect(body.ignored).toEqual([]);
    expect(await cfg.getConfigValue('pulseUserBriefingModel')).toBe('');
  });

  it('choosing "use organisation briefing model" for Developer Pulse saves the blank', async () => {
    await cfg.setConfigValue('codeBriefingModel', 'claude-sonnet-5');
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ codeBriefingModel: '' }));
    const body = await res.json();
    expect(body.ignored).toEqual([]);
    expect(await cfg.getConfigValue('codeBriefingModel')).toBe('');
  });

  it('a normal save reports ok with empty ignored', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(post({ organisationName: 'Acme Corp' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toEqual([]);
    expect(await cfg.getConfigValue('organisationName')).toBe('Acme Corp');
  });
});

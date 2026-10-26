// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string } | null = null;
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(() => (sessionResult?.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({ logAccess: (...a: unknown[]) => logAccessMock(...a) }));

function makeDelete(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config/secret', {
    method: 'DELETE',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DELETE /api/config/secret', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  it('rejects non-admin with 403', async () => {
    sessionResult = null;
    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: 'complianceAccessKey' }));
    expect(res.status).toBe(403);
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });

  it('rejects an unregistered key with 400', async () => {
    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: 'organisationName' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a removable secret/i);
  });

  it('rejects __proto__ (prototype pollution) with 400, not 500', async () => {
    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: '__proto__' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a removable secret/i);
  });

  it('removes the key AND its associated sync state, audits, and lists cleared keys', async () => {
    await cfg.setConfigValue('complianceAccessKey', 'sk-ant-api01-test');
    await cfg.setConfigValue('complianceChatCursor', 'cursor-abc');
    await cfg.setConfigValue('complianceLastSyncAt', '1784809407');

    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: 'complianceAccessKey' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleared).toContain('complianceAccessKey');
    expect(body.cleared).toContain('complianceChatCursor');

    expect(await cfg.getConfigValue('complianceAccessKey')).toBe('');
    expect(await cfg.getConfigValue('complianceChatCursor')).toBe('');
    expect(await cfg.getConfigValue('complianceLastSyncAt')).toBe('');

    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'config/complianceAccessKey',
      action: 'DELETE',
      outcome: 'success',
    }));
  });

  it('removes a key with no associated state', async () => {
    await cfg.setConfigValue('smtpPassword', 'hunter2');
    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: 'smtpPassword' }));
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toEqual(['smtpPassword']);
    expect(await cfg.getConfigValue('smtpPassword')).toBe('');
  });

  it('never echoes secret values in the response', async () => {
    await cfg.setConfigValue('dxApiKey', 'dx-secret-value');
    const { DELETE } = await import('../app/api/config/secret/route');
    const res = await DELETE(makeDelete({ key: 'dxApiKey' }));
    expect(JSON.stringify(await res.json())).not.toContain('dx-secret-value');
  });
});

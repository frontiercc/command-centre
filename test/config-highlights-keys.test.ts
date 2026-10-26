// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const saveConfig = vi.fn();
vi.mock('@/lib/config', () => ({
  saveConfig: (...a: unknown[]) => saveConfig(...a),
  getAllConfig: vi.fn(async () => ({})),
  AppConfig: {},
}));
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c' })),
  getAdminSession: vi.fn(async () => ({ authenticated: true, userId: 'u1', email: 'a@b.c' })),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn(async () => {}) }));

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/config', { method: 'POST', body: JSON.stringify(body) });
}

describe('highlights config keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts the three highlights keys and passes them to saveConfig', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(req({
      highlightsEnabled: 'true',
      highlightsModel: 'claude-sonnet-5',
      highlightsIncludeNames: 'false',
    }));
    expect(res.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      highlightsEnabled: 'true',
      highlightsModel: 'claude-sonnet-5',
      highlightsIncludeNames: 'false',
    }));
  });

  it('does not persist an unknown highlights key', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(req({ highlightsBogus: 'true' }));
    expect(res.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith(expect.not.objectContaining({
      highlightsBogus: expect.anything(),
    }));
    const call = saveConfig.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(call)).not.toContain('highlightsBogus');
  });
});

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

describe('retention config keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts the three new retention keys and passes them to saveConfig', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(req({ retentionCodeDays: '45', retentionAlertsDays: '60', retentionAnalyticsDays: '200' }));
    expect(res.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      retentionCodeDays: '45', retentionAlertsDays: '60', retentionAnalyticsDays: '200',
    }));
  });

  it('rejects a retention value below 7', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(req({ retentionCodeDays: '3' }));
    expect(res.status).toBe(400);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

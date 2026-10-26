// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Guards that the FinOps enable toggle's key round-trips through the config
// POST route (i.e. chargebackEnabled is in allowedKeys and reaches saveConfig).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const saveConfig = vi.fn();

vi.mock('@/lib/config', () => ({
  saveConfig: (...args: unknown[]) => saveConfig(...args),
  getAllConfig: vi.fn(async () => ({})),
  AppConfig: {},
}));
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c' })),
  getAdminSession: vi.fn(async () => ({ authenticated: true, userId: 'u1', email: 'a@b.c' })),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn(async () => {}) }));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/config', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/config chargebackEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts chargebackEnabled and passes it to saveConfig', async () => {
    const { POST } = await import('../app/api/config/route');
    const res = await POST(makeRequest({ chargebackEnabled: 'true' }));
    expect(res.status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ chargebackEnabled: 'true' })
    );
  });
});

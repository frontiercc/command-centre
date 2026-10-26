// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

// ── Dashboard route mocks (module-level, apply to the whole file) ──
let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessCorePlatform: vi.fn((role: string | undefined) => role === 'admin' || role === 'viewer'),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

let cleanup: () => Promise<void>;
let cfg: typeof import('@/lib/config');
let route: typeof import('../app/api/dashboard/route');

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  cfg = await import('@/lib/config');
  route = await import('../app/api/dashboard/route');
  sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
});

afterAll(async () => cleanup());

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/dashboard', { method: 'GET' });
}

describe('Licensed seats config', () => {
  it('defaults to empty string (unset)', async () => {
    const c = (await cfg.getAllConfig());
    expect(c.licensedSeats).toBe('');
  });

  it('round-trips via setConfigValue/getConfigValue', async () => {
    await cfg.setConfigValue('licensedSeats', '135');
    expect(await cfg.getConfigValue('licensedSeats')).toBe('135');
    expect((await cfg.getAllConfig()).licensedSeats).toBe('135');
  });
});

describe('GET /api/dashboard licensedSeats', () => {
  it('returns licensedSeats: 135 when set to a valid positive integer', async () => {
    await cfg.setConfigValue('licensedSeats', '135');
    const res = await route.GET(makeRequest());
    const body = await res.json();
    expect(body.licensedSeats).toBe(135);
  });

  it('returns licensedSeats: null when unset', async () => {
    await cfg.setConfigValue('licensedSeats', '');
    const res = await route.GET(makeRequest());
    const body = await res.json();
    expect(body.licensedSeats).toBeNull();
  });

  it('returns licensedSeats: null when unparseable', async () => {
    await cfg.setConfigValue('licensedSeats', 'abc');
    const res = await route.GET(makeRequest());
    const body = await res.json();
    expect(body.licensedSeats).toBeNull();
  });

  it('returns licensedSeats: null when <= 0', async () => {
    await cfg.setConfigValue('licensedSeats', '0');
    const res = await route.GET(makeRequest());
    const body = await res.json();
    expect(body.licensedSeats).toBeNull();
  });
});

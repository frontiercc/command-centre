// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The collector address an admin sets with Edit on Admin → Ingestion: saved
// through POST /api/config, refused unless http or https, and returned by the
// admin-only otel-status route in place of CCC_COLLECTOR_ADDRESS.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let role = 'admin';
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(async () => (role === 'admin' ? { authenticated: true, role, userId: 'u1', email: 'admin@example.com' } : null)),
  getAdminSession: vi.fn(async () => ({ authenticated: true, role, userId: 'u1', email: 'admin@example.com' })),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

let cleanup: () => Promise<void>;
let cfg: typeof import('@/lib/config');
let configRoute: typeof import('../app/api/config/route');
let statusRoute: typeof import('../app/api/admin/otel-status/route');

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  process.env.CCC_CLIENT_BEARER_TOKEN = 'tok123';
  process.env.CCC_COLLECTOR_ADDRESS = 'https://from-env.example.com';
  cfg = await import('@/lib/config');
  configRoute = await import('../app/api/config/route');
  statusRoute = await import('../app/api/admin/otel-status/route');
});

afterAll(async () => {
  delete process.env.CCC_CLIENT_BEARER_TOKEN;
  delete process.env.CCC_COLLECTOR_ADDRESS;
  await cleanup();
});

function post(body: unknown) {
  return configRoute.POST(new NextRequest('http://localhost/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

async function shownAddress() {
  const res = await statusRoute.GET(new NextRequest('http://localhost/api/admin/otel-status'));
  return (await res.json()).collector?.address;
}

describe('collector address set by an admin', () => {
  it('falls back to CCC_COLLECTOR_ADDRESS until one is saved', async () => {
    expect(await shownAddress()).toBe('https://from-env.example.com');
  });

  it('saves an https address without its trailing slash and shows it', async () => {
    const res = await post({ otelCollectorAddress: 'https://otel.example.com/' });
    expect(res.status).toBe(200);
    expect(await cfg.getConfigValue('otelCollectorAddress')).toBe('https://otel.example.com');
    expect(await shownAddress()).toBe('https://otel.example.com');
  });

  it('refuses an address that is not http or https, keeping the saved one', async () => {
    const res = await post({ otelCollectorAddress: 'otel.example.com' });
    expect(res.status).toBe(400);
    expect(await shownAddress()).toBe('https://otel.example.com');
  });

  it('clears to the .env address when saved blank', async () => {
    const res = await post({ otelCollectorAddress: '' });
    expect(res.status).toBe(200);
    expect(await shownAddress()).toBe('https://from-env.example.com');
  });

  it('cannot be changed by a non-admin', async () => {
    role = 'manager';
    const res = await post({ otelCollectorAddress: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    role = 'admin';
    expect(await shownAddress()).toBe('https://from-env.example.com');
  });
});

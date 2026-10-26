// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Verifies GET /api/ai/report enforces canAccessCorePlatform (admin|viewer|manager)
// and refuses the dept-scoped contributor roles (pulse|code|cowork) with 403.
// Uses the REAL canAccessCorePlatform (only getAdminSession is overridden) so the
// test breaks if the route stops calling the gate or the helper's role set drifts.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };

vi.mock('@/lib/auth/admin-auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: vi.fn(() => sessionResult) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({
  getReports: vi.fn(async () => []),
  getReportById: vi.fn(async () => null),
  insertReport: vi.fn(async () => {}),
}));
vi.mock('@/lib/anthropic/ai', () => ({ generateGovernanceReport: vi.fn(async () => '## Executive Summary\nx') }));

let route: typeof import('../app/api/ai/report/route');

beforeAll(async () => {
  route = await import('../app/api/ai/report/route');
});

function get(): NextRequest {
  return new NextRequest('http://localhost/api/ai/report', { method: 'GET' });
}

describe('GET /api/ai/report authorization', () => {
  it('401 when unauthenticated', async () => {
    sessionResult = { authenticated: false };
    expect((await route.GET(get())).status).toBe(401);
  });

  it.each(['admin', 'viewer', 'manager'])('allows core-platform role %s', async (role) => {
    sessionResult = { authenticated: true, role, userId: 'u1', email: 'u@x.com' };
    const res = await route.GET(get());
    expect(res.status).toBe(200);
  });

  it.each(['pulse', 'code', 'cowork'])('403 for dept-scoped role %s', async (role) => {
    sessionResult = { authenticated: true, role, userId: 'u1', email: 'u@x.com' };
    const res = await route.GET(get());
    expect(res.status).toBe(403);
  });
});

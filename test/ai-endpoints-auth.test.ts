// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression guard for the AI-cost endpoint (analyze POST) that previously ran
// with NO session/role check — reachable by any request carrying an
// arbitrary session cookie, triggering paid Claude API calls. It must enforce
// canAccessCorePlatform. (The stream GET was deleted: no page used it.) Uses the REAL helper (only getAdminSession is overridden).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };

vi.mock('@/lib/auth/admin-auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: vi.fn(() => sessionResult) };
});
vi.mock('@/lib/anthropic/ai', () => ({
  runAnomalyDetection: vi.fn(async () => []),
  generateAdoptionInsights: vi.fn(async () => ({})),
}));
vi.mock('@/lib/db/queries', () => ({ getRecentAlerts: vi.fn(async () => []) }));
vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(async () => '60') }));

let analyze: typeof import('../app/api/ai/analyze/route');

beforeAll(async () => {
  analyze = await import('../app/api/ai/analyze/route');
});

const post = () => new NextRequest('http://localhost/api/ai/analyze', { method: 'POST' });

describe('POST /api/ai/analyze authorization', () => {
  it('401 when unauthenticated (arbitrary cookie only)', async () => {
    sessionResult = { authenticated: false };
    expect((await analyze.POST(post())).status).toBe(401);
  });
  it.each(['pulse', 'code', 'cowork'])('403 for dept-scoped role %s', async (role) => {
    sessionResult = { authenticated: true, role, userId: 'u1', email: 'u@x.com' };
    expect((await analyze.POST(post())).status).toBe(403);
  });
  it.each(['admin', 'viewer', 'manager'])('allows core role %s', async (role) => {
    sessionResult = { authenticated: true, role, userId: 'u1', email: 'u@x.com' };
    expect((await analyze.POST(post())).status).toBe(200);
  });
});

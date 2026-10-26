// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ChargebackReport } from '@/lib/finance/chargeback';

const cfg = { chargebackEnabled: true };
let sessionResult: { authenticated: boolean; userId?: string; email?: string; role?: string };

vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
  getConfigValue: () => undefined,
}));

vi.mock('@/lib/finance/insight-narrative', () => ({
  generateInsightNarrative: async () => ({ text: null }),
}));

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: () => sessionResult,
  };
});

const buildChargebackMock = vi.fn<(period: string) => ChargebackReport>(() => ({
  period: '2026-03',
  grandTotalUsd: 0,
  costCentres: [],
  unallocated: { totalUsd: 0, users: [] },
  estimated: false,
  unpricedModels: [],
  coworkCostCoverage: { withCost: 0, total: 0 },
  codeTokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  cacheSavingsUsd: 0,
  periodStart: 0,
  periodEnd: 0,
  monthToDate: false,
  status: 'open',
  closedAt: null,
  surfaces: {
    chat: { usd: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'dormant' },
    code: { usd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'estimate' },
    cowork: { usd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'actual' },
    total: { usd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } },
  },
  leaderboard: [],
}));

vi.mock('@/lib/finance/chargeback', () => ({
  buildChargeback: buildChargebackMock,
}));

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({
  logAccess: logAccessMock,
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  vi.resetModules();
  cfg.chargebackEnabled = true;
  sessionResult = { authenticated: true, userId: 'a1', email: 'm@x.test', role: 'manager' };
  buildChargebackMock.mockClear();
  logAccessMock.mockClear();
});

describe('GET /api/finance/chargeback', () => {
  it('returns 404 when the feature flag is off', async () => {
    cfg.chargebackEnabled = false;
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a viewer role', async () => {
    sessionResult = { authenticated: true, userId: 'v1', email: 'v@x.test', role: 'viewer' };
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(403);
  });

  it('returns 200 with the report for a manager role and logs access', async () => {
    sessionResult = { authenticated: true, userId: 'm1', email: 'm@x.test', role: 'manager' };
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('grandTotalUsd');
    // Additive Workflow Impact field (lib/finance/seats.ts) — null or an object,
    // never absent, so the contract can't silently drop again.
    expect(body).toHaveProperty('seats');
    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/chargeback', action: 'READ', outcome: 'success' })
    );
  });

  it('returns 200 with the report for an admin role', async () => {
    sessionResult = { authenticated: true, userId: 'ad1', email: 'ad@x.test', role: 'admin' };
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(200);
  });

  it('returns 400 for a malformed period', async () => {
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback?period=2026-3'));
    expect(res.status).toBe(400);
  });

  it('does not include drivers/reconciliation/enterpriseSource fields (Enterprise cost-drivers section removed)', async () => {
    const { GET } = await import('../app/api/finance/chargeback/route');
    const res = await GET(makeRequest('/api/finance/chargeback'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).not.toHaveProperty('drivers');
    expect(body).not.toHaveProperty('reconciliation');
    expect(body).not.toHaveProperty('enterpriseSource');
    // Chat stays dormant regardless — CCC has no first-party Chat cost capture.
    expect(body.surfaces.chat.basis).toBe('dormant');
  });
});

describe('GET /api/finance/chargeback/export', () => {
  beforeEach(() => {
    buildChargebackMock.mockReturnValue({
      period: '2026-03',
      periodStart: 0,
      periodEnd: 0,
      monthToDate: false,
      status: 'open',
      closedAt: null,
      grandTotalUsd: 3.5,
      estimated: false,
      unpricedModels: [],
      coworkCostCoverage: { withCost: 1, total: 1 },
      codeTokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      cacheSavingsUsd: 0,
      costCentres: [
        {
          name: 'Legal',
          code: null,
          totalUsd: 2.5,
          codeUsd: 2.0,
          coworkUsd: 0.5,
          users: [{ userId: 'u1', displayName: 'Alice', codeUsd: 2.0, coworkUsd: 0.5, totalUsd: 2.5, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }],
        },
      ],
      unallocated: {
        totalUsd: 1.0,
        users: [{ userId: 'u2', displayName: 'Bob', codeUsd: 1.0, coworkUsd: 0, totalUsd: 1.0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }],
      },
      surfaces: {
        chat: { usd: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'dormant' },
        code: { usd: 3.0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'estimate' },
        cowork: { usd: 0.5, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, basis: 'actual' },
        total: { usd: 3.5, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } },
      },
      leaderboard: [
        { userId: 'u1', displayName: 'Alice', totalUsd: 2.5, codeUsd: 2.0, coworkUsd: 0.5 },
        { userId: 'u2', displayName: 'Bob', totalUsd: 1.0, codeUsd: 1.0, coworkUsd: 0 },
      ],
    });
  });

  it('returns 404 when the feature flag is off', async () => {
    cfg.chargebackEnabled = false;
    const { GET } = await import('../app/api/finance/chargeback/export/route');
    const res = await GET(makeRequest('/api/finance/chargeback/export'));
    expect(res.status).toBe(404);
  });

  it('returns 403 for a viewer role', async () => {
    sessionResult = { authenticated: true, userId: 'v1', email: 'v@x.test', role: 'viewer' };
    const { GET } = await import('../app/api/finance/chargeback/export/route');
    const res = await GET(makeRequest('/api/finance/chargeback/export'));
    expect(res.status).toBe(403);
  });

  it('returns 200 with CSV for a manager role', async () => {
    sessionResult = { authenticated: true, userId: 'm1', email: 'm@x.test', role: 'manager' };
    const { GET } = await import('../app/api/finance/chargeback/export/route');
    const res = await GET(makeRequest('/api/finance/chargeback/export?period=2026-03'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('chargeback-2026-03.csv');
    const body = await res.text();
    expect(body).toContain('Cost Cent');
    expect(body).toContain('Legal,Alice,2.00,0.50,2.50');
    expect(body).toContain('Unallocated,Bob,1.00,0.00,1.00');
    expect(body).toContain('TOTAL,,3.00,0.50,3.50');
    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/chargeback', action: 'EXPORT', outcome: 'success' })
    );
  });
});

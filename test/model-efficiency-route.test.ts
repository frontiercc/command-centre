// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ModelEfficiencyReport } from '@/lib/finance/model-efficiency';

const cfg = { financeModelEfficiencyEnabled: true, chargebackEnabled: true };
let sessionResult: { authenticated: boolean; userId?: string; email?: string; role?: string };

vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
  getConfigValue: () => undefined,
}));

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: () => sessionResult,
  };
});

const buildModelEfficiencyMock = vi.fn<
  (surface: 'code' | 'cowork', period: string, nowS?: number) => Promise<ModelEfficiencyReport>
>(async (surface) => ({
  surface,
  enabled: true,
  hasData: false,
  period: { start: 0, end: 0 },
  totals: { spendUsd: 0, tokens: 0 },
  activities: [],
  unpricedModels: [],
  belowVolume: [],
  modelOrder: [],
  cacheEfficiency: { ratio: null, cacheReadTokens: 0, inputSideTokens: 0 },
  spendByModel: [],
  costByType: { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, unclassifiedUsd: 0 },
}));

vi.mock('@/lib/finance/model-efficiency', () => ({
  buildModelEfficiency: buildModelEfficiencyMock,
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
  cfg.financeModelEfficiencyEnabled = true;
  cfg.chargebackEnabled = true;
  sessionResult = { authenticated: true, userId: 'm1', email: 'm@x.test', role: 'manager' };
  buildModelEfficiencyMock.mockClear();
  logAccessMock.mockClear();
});

describe('GET /api/finance/model-efficiency', () => {
  it('returns 404 when financeModelEfficiencyEnabled is off', async () => {
    cfg.financeModelEfficiencyEnabled = false;
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 404 when chargebackEnabled is off, even if financeModelEfficiencyEnabled is on', async () => {
    cfg.chargebackEnabled = false;
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code'));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a viewer role', async () => {
    sessionResult = { authenticated: true, userId: 'v1', email: 'v@x.test', role: 'viewer' };
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code'));
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid surface', async () => {
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=chat'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/surface/i);
  });

  it('returns 400 for a missing surface param', async () => {
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed period', async () => {
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code&period=2026-3'));
    expect(res.status).toBe(400);
  });

  it('returns 200 with the report for an admin role, echoing surface, and logs access', async () => {
    sessionResult = { authenticated: true, userId: 'ad1', email: 'ad@x.test', role: 'admin' };
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=code&period=2026-03'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.surface).toBe('code');
    expect(buildModelEfficiencyMock).toHaveBeenCalledWith('code', '2026-03', expect.any(Number));
    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/model-efficiency', action: 'READ', outcome: 'success' })
    );
  });

  it('returns 200 for a manager role with surface=cowork, echoing surface', async () => {
    const { GET } = await import('../app/api/finance/model-efficiency/route');
    const res = await GET(makeRequest('/api/finance/model-efficiency?surface=cowork'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.surface).toBe('cowork');
  });
});

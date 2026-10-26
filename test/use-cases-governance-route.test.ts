// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const cfg = { useCasesEnabled: true, useCasesMinutesSavedPerSession: '30', useCasesLoadedCompAnnual: '90000' };
let sessionResult: { authenticated: boolean; role?: string };

vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
}));

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: () => sessionResult,
  };
});

vi.mock('@/lib/usecases/governance', () => ({
  buildGovernanceRollup: vi.fn(() => ({
    window: { weeks: 13, endsWeekStart: 0, label: 'Quarter to 1 Jan 2026' },
    headline: { declared: 0, adopted: 0, piloting: 0, atRisk: 0, notSeen: 0 },
    value: { hoursRecovered: 0, dollarsRecovered: 0, isEstimate: true, calibration: { minutesPerSession: 30, loadedCompAnnual: 90000, workingHoursPerYear: 2080 } },
    narrative: 'No strategic bets have been declared yet.',
    bets: [],
  })),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  vi.resetModules();
  cfg.useCasesEnabled = true;
  cfg.useCasesMinutesSavedPerSession = '30';
  cfg.useCasesLoadedCompAnnual = '90000';
  sessionResult = { authenticated: true, role: 'viewer' };
});

describe('GET /api/use-cases/governance', () => {
  it('returns 404 when the feature flag is off', async () => {
    cfg.useCasesEnabled = false;
    const { GET } = await import('../app/api/use-cases/governance/route');
    const res = await GET(makeRequest('/api/use-cases/governance'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('allows a viewer role (deliberately looser org-overview gate)', async () => {
    sessionResult = { authenticated: true, role: 'viewer' };
    const { GET } = await import('../app/api/use-cases/governance/route');
    const res = await GET(makeRequest('/api/use-cases/governance'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headline).toEqual({ declared: 0, adopted: 0, piloting: 0, atRisk: 0, notSeen: 0 });
  });

  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/use-cases/governance/route');
    const res = await GET(makeRequest('/api/use-cases/governance'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role that fails canAccessOrgOverview', async () => {
    sessionResult = { authenticated: true, role: 'cowork' };
    const { GET } = await import('../app/api/use-cases/governance/route');
    const res = await GET(makeRequest('/api/use-cases/governance'));
    expect(res.status).toBe(403);
  });
});

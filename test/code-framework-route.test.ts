// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(async () => ({ authenticated: true, role: 'admin' })),
  canAccessOrgOverview: (r: string) => ['admin', 'manager', 'viewer'].includes(r),
}));
vi.mock('@/lib/config', () => ({
  getAllConfig: vi.fn(async () => ({ dxFrameworkEnabled: false, codeClassifierEnabled: true })),
  getConfigValue: vi.fn(async () => ''),
}));

import { GET } from '@/app/api/pulse/code/framework/route';
import { computeEngagedHours } from '@/lib/pulse/code/framework';

describe('GET /api/pulse/code/framework', () => {
  it('returns {enabled:false} at 200 when the flag is off', async () => {
    const res = await GET(new Request('http://x/api/pulse/code/framework') as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

// Regression: a code_metrics row can exist (hasData=true) with BOTH
// active-time columns NULL (the OTel metrics stream isn't configured on this
// instance) — this must render "Engaged: —", never fabricate "Engaged: 0".
// Mocking the full Drizzle query-builder chain for this route isn't done
// elsewhere in the repo (no existing test mocks @/lib/db/client with a
// chained select/from/where/orderBy/limit builder), so per the task brief's
// fallback, the engagedHours computation was extracted into the pure
// exported `computeEngagedHours` helper in lib/pulse/code/framework.ts
// (the route imports it) and is unit-tested directly here.
describe('computeEngagedHours', () => {
  it('returns null when both active-time columns are null (never 0)', () => {
    expect(computeEngagedHours(null, null)).toBeNull();
  });

  it('computes hours when only one side is present, treating the other as 0', () => {
    expect(computeEngagedHours(3600, null)).toBe(1);
    expect(computeEngagedHours(null, 7200)).toBe(2);
  });

  it('computes hours when both sides are present', () => {
    expect(computeEngagedHours(3600, 3600)).toBe(2);
  });
});

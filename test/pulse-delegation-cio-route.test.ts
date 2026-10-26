// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route test: GET /api/pulse/cio returns the additive `delegation` field.
// Auth is mocked to an admin session; DB is a migrated
// Postgres test database (createTestDbClient('postgres')).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...mod,
    getAdminSession: vi.fn(async () => ({
      authenticated: true, role: 'admin', userId: 'admin-1',
      email: 'a@test.local', department: null,
    })),
  };
});

const WEEK = 7 * 86400;

describe('GET /api/pulse/cio — delegation field', () => {
  it('returns per-dept depth segments for the requested window and coerces bad ?weeks=', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { weekStarts } = await import('@/lib/pulse/period');
      const now = Math.floor(Date.now() / 1000);
      // 26-week window + current week: seed dept 'Finance' weekly rows on the
      // 6 completed weeks before now, 10 events/week, depth rising.
      const wks = weekStarts(now, 8).slice(0, 7); // 7 oldest of 8 = completed weeks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      const { schema } = await import('@/lib/db/schema');
      for (let i = 0; i < 6; i++) {
        await db.insert(schema.pulseMetrics).values({
          scope_type: 'function', scope_id: 'Finance',
          period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 10, tier_1_count: 8 - i, tier_2_count: 1 + i, tier_3_count: 1,
          computed_at: now, granularity: 'week',
        });
        // Two user-scope rows per week feed the ORG band aggregate:
        // u-x mirrors Finance's rising mix (10/wk), u-y is flat 4/1/0 (5/wk).
        await db.insert(schema.pulseMetrics).values({
          scope_type: 'user', scope_id: 'u-x',
          period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 10, tier_1_count: 8 - i, tier_2_count: 1 + i, tier_3_count: 1,
          computed_at: now, granularity: 'week',
        });
        await db.insert(schema.pulseMetrics).values({
          scope_type: 'user', scope_id: 'u-y',
          period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 5, tier_1_count: 4, tier_2_count: 1, tier_3_count: 0,
          computed_at: now, granularity: 'week',
        });
      }
      const { GET } = await import('@/app/api/pulse/cio/route');
      const res = await GET(new NextRequest('http://x/api/pulse/cio?weeks=999'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delegation.window).toBe(26); // 999 coerced

      // Org-wide bands: user-scope rows summed per week (12/2/1 = 15 in week 0).
      expect(body.delegation.org.bandsDataWeeks).toBe(6);
      const orgWeeks = body.delegation.org.bands.flatMap(
        (s: { weeks: Array<{ weekStart: number; t1Share: number | null }> }) => s.weeks);
      const orgW0 = orgWeeks.find((w: { weekStart: number }) => w.weekStart === wks[0]);
      expect(orgW0.t1Share).toBeCloseTo(12 / 15, 5);

      // Departments render as then-vs-now rows (no more segments payload).
      const fin = body.delegation.departments.find((d: { dept: string }) => d.dept === 'Finance');
      expect(fin).toBeDefined();
      expect(fin.dataWeeks).toBe(6);
      // Depths rise 0.2..0.7 over 6 data-weeks → k=3: then=0.3, now=0.6, up.
      expect(fin.thenVsNow.then).toBeCloseTo(0.3, 5);
      expect(fin.thenVsNow.now).toBeCloseTo(0.6, 5);
      expect(fin.thenVsNow.arrow).toBe('up');
      expect(fin.sparkline.filter((v: number | null) => v !== null)).toHaveLength(6);
      expect(body.delegation.building).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

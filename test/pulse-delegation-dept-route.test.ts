// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route test: GET /api/pulse/dept/[dept] returns the additive `delegation`
// field with dept bands and per-person then-vs-now.
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

describe('GET /api/pulse/dept/[dept] — delegation field', () => {
  it('returns dept band segments and per-person rows; sparse person shows null thenVsNow', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { weekStarts } = await import('@/lib/pulse/period');
      const { schema } = await import('@/lib/db/schema');
      const now = Math.floor(Date.now() / 1000);
      const wks = weekStarts(now, 8).slice(0, 7);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      await db.insert(schema.users).values([
        { id: 'u-anna', email: 'anna@test.local', display_name: 'Anna', department: 'Finance' },
        { id: 'u-bob', email: 'bob@test.local', display_name: 'Bob', department: 'Finance' },
      ]);
      // Dept bands: 6 weekly function rows.
      for (let i = 0; i < 6; i++) {
        await db.insert(schema.pulseMetrics).values({
          scope_type: 'function', scope_id: 'Finance',
          period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 10, tier_1_count: 6, tier_2_count: 3, tier_3_count: 1,
          computed_at: now, granularity: 'week',
        });
      }
      // Anna: 6 user-scope weeks, >= 3 events each → full then-vs-now.
      for (let i = 0; i < 6; i++) {
        await db.insert(schema.pulseMetrics).values({
          scope_type: 'user', scope_id: 'u-anna',
          period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 10, tier_1_count: 5 - Math.min(i, 4), tier_2_count: 4 + Math.min(i, 4), tier_3_count: 1,
          computed_at: now, granularity: 'week',
        });
      }
      // Bob: 1 sparse week (2 events < floor) → appears with 0 qualifying weeks → omitted.
      await db.insert(schema.pulseMetrics).values({
        scope_type: 'user', scope_id: 'u-bob',
        period_start: wks[0], period_end: wks[0] + WEEK,
        event_count: 2, tier_1_count: 2, tier_2_count: 0, tier_3_count: 0,
        computed_at: now, granularity: 'week',
      });

      const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
      const res = await GET(
        new NextRequest('http://x/api/pulse/dept/Finance?weeks=13'),
        { params: Promise.resolve({ dept: 'Finance' }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delegation.window).toBe(13);
      expect(body.delegation.bandsDataWeeks).toBe(6);
      expect(body.delegation.bands[0].weeks.some((w: { t1Share: number | null }) => w.t1Share === 0.6)).toBe(true);
      const anna = body.delegation.people.find((p: { userId: string }) => p.userId === 'u-anna');
      expect(anna.displayName).toBe('Anna');
      expect(anna.thenVsNow).not.toBeNull();
      expect(anna.thenVsNow.arrow).toBe('up');
      expect(anna.sparkline.filter((v: number | null) => v !== null)).toHaveLength(6);
      expect(body.delegation.people.find((p: { userId: string }) => p.userId === 'u-bob')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A rubric save never splits the delegation charts or blanks the then-vs-now
// arrows: admins update the tiers often, and each save used
// to blank the department arrows for four weeks. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/admin-auth')>();
  return { ...mod, getAdminSession: vi.fn(async () => ({ authenticated: true, role: 'admin', userId: 'admin-1', email: 'a@test.local', department: null })) };
});

const WEEK = 7 * 86400;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;

describe('delegation charts ignore rubric saves (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('a save in the middle of the window changes nothing on /pulse/cio', async () => {
    const { weekStarts } = await import('@/lib/pulse/period');
    const { schema } = await import('@/lib/db/schema');
    const now = Math.floor(Date.now() / 1000);
    const wks = weekStarts(now, 8).slice(0, 7);
    for (let i = 0; i < 6; i++) {
      for (const [scope_type, scope_id] of [['function', 'Finance'], ['user', 'u-x']]) {
        await db.insert(schema.pulseMetrics).values({
          scope_type, scope_id, period_start: wks[i], period_end: wks[i] + WEEK,
          event_count: 10, tier_1_count: 8 - i, tier_2_count: 1 + i, tier_3_count: 1,
          computed_at: now, granularity: 'week',
        });
      }
    }
    const { GET } = await import('@/app/api/pulse/cio/route');
    const read = async () => (await (await GET(new NextRequest('http://x/api/pulse/cio?weeks=26'))).json()).delegation;

    const before = await read();
    // An admin saves the rubric two weeks before now: inside the window.
    await db.insert(schema.pulseRubricVersions).values({ changed_by: 'admin@test.local', changed_at: wks[4] + 3600, rubric_json: '{}', change_summary: null });
    const after = await read();

    const fin = (d: { departments: Array<{ dept: string }> }) => d.departments.find(x => x.dept === 'Finance') as unknown as { thenVsNow: { then: number; now: number; arrow: string }; dataWeeks: number; sparkline: Array<number | null> };
    expect(fin(after)).toEqual(fin(before));
    expect(fin(after).thenVsNow).toMatchObject({ arrow: 'up' });
    expect(fin(after).thenVsNow.then).toBeCloseTo(0.3, 5);
    expect(fin(after).thenVsNow.now).toBeCloseTo(0.6, 5);
    expect(fin(after).dataWeeks).toBe(6);
    expect(fin(after).sparkline.filter((v: number | null) => v !== null)).toHaveLength(6);
    expect(after.org.bands).toHaveLength(1);
    expect(after.org.bands[0].startsAtRubricBreak).toBe(false);
    expect(after.org).toEqual(before.org);
  });
});

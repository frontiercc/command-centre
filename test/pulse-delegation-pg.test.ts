// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Delegation View's additive `delegation`
// field on GET /api/pulse/cio and GET /api/pulse/dept/[dept].
// The route tests live in
// test/pulse-delegation-cio-route.test.ts and test/pulse-delegation-dept-
// route.test.ts — this file ports their seed rows and assertions verbatim
// against a real postgres:16 testcontainer, proving:
//   - bigint period_start/computed_at columns round-trip through the pure
//     lib/pulse/delegation.ts builders unchanged.
//   - the rubric-changed_at gte() query and the per-dept/per-user pulse_metrics
//     window queries behave identically on pg.
//
// HARNESS RULE (copied from highlights-pg.test.ts / otel-receivers-pg.test.ts):
// getClient() binds to DATABASE_URL on first use, so the route modules (and schema) are DYNAMIC-imported AFTER
// createTestDbClient('postgres') has set DATABASE_URL + reset modules. No
// manual DDL is needed — createTestDbClient('postgres') boots the container
// via startPg(), which already applies the full committed lib/db/
// migrations-pg set, so every table these routes touch already exists.
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

describe('delegation view routes (postgres)', () => {
  it(
    'GET /api/pulse/cio returns org bands + dept then-vs-now rows and coerces bad ?weeks=',
    async () => {
      const { createTestDbClient } = await import('./helpers/db');
      const { client, cleanup } = await createTestDbClient('postgres');
      try {
        // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
        const { schema } = await import('@/lib/db/schema');
        const { weekStarts } = await import('@/lib/pulse/period');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = client as any;

        const now = Math.floor(Date.now() / 1000);
        // 26-week window + current week: seed dept 'Finance' weekly rows on the
        // 6 completed weeks before now, 10 events/week, depth rising — plus two
        // user-scope rows per week feeding the ORG band aggregate (12/2/1 = 15
        // summed in week 0), mirroring the route-test twin.
        const wks = weekStarts(now, 8).slice(0, 7); // 7 oldest of 8 = completed weeks
        for (let i = 0; i < 6; i++) {
          await db.insert(schema.pulseMetrics).values({
            scope_type: 'function', scope_id: 'Finance',
            period_start: wks[i], period_end: wks[i] + WEEK,
            event_count: 10, tier_1_count: 8 - i, tier_2_count: 1 + i, tier_3_count: 1,
            computed_at: now, granularity: 'week',
          });
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

        // Org-wide bands: user-scope rows summed per week.
        expect(body.delegation.org.bandsDataWeeks).toBe(6);
        const orgWeeks = body.delegation.org.bands.flatMap(
          (s: { weeks: Array<{ weekStart: number; t1Share: number | null }> }) => s.weeks);
        const orgW0 = orgWeeks.find((w: { weekStart: number }) => w.weekStart === wks[0]);
        expect(orgW0.t1Share).toBeCloseTo(12 / 15, 5);

        // Departments render as then-vs-now rows.
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
    },
    180_000,
  );

  it(
    'GET /api/pulse/dept/[dept] returns dept band segments and per-person rows; sparse person shows null thenVsNow',
    async () => {
      const { createTestDbClient } = await import('./helpers/db');
      const { client, cleanup } = await createTestDbClient('postgres');
      try {
        // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
        const { schema } = await import('@/lib/db/schema');
        const { weekStarts } = await import('@/lib/pulse/period');
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
    },
    180_000,
  );
});

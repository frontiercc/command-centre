// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

// ─── Pure-function tests (no DB) ────────────────────────────────────────────

import { projectMonthEndSpend } from '@/lib/pulse/code/projection';

function utcEpoch(y: number, m: number, d: number, h = 12): number {
  return Math.floor(Date.UTC(y, m - 1, d, h) / 1000);
}

describe('projectMonthEndSpend', () => {
  it('mid-month projection arithmetic', () => {
    // 2026-06-15 12:00 UTC — June has 30 days, day 15 elapsed, 15 remaining.
    const now = utcEpoch(2026, 6, 15);
    const result = projectMonthEndSpend(100, 35, now);
    // projected = mtd + (last7d / 7) * daysRemaining = 100 + (35/7) * 15 = 100 + 75 = 175
    expect(result.projected).toBeCloseTo(175, 6);
    expect(result.daysElapsed).toBe(15);
    expect(result.daysInMonth).toBe(30);
  });

  it('last day of month projects to exactly mtdSpend (no days remaining)', () => {
    // 2026-06-30 — day 30 elapsed of 30, 0 remaining.
    const now = utcEpoch(2026, 6, 30);
    const result = projectMonthEndSpend(200, 49, now);
    expect(result.projected).toBeCloseTo(200, 6);
    expect(result.daysElapsed).toBe(30);
    expect(result.daysInMonth).toBe(30);
  });

  it('handles leap February day count (2028 is a leap year)', () => {
    const now = utcEpoch(2028, 2, 10);
    const result = projectMonthEndSpend(50, 14, now);
    expect(result.daysInMonth).toBe(29);
    expect(result.daysElapsed).toBe(10);
    // daysRemaining = 19; projected = 50 + (14/7)*19 = 50 + 38 = 88
    expect(result.projected).toBeCloseTo(88, 6);
  });

  it('handles non-leap February day count (2027 is not a leap year)', () => {
    const now = utcEpoch(2027, 2, 10);
    const result = projectMonthEndSpend(50, 14, now);
    expect(result.daysInMonth).toBe(28);
  });
});

// ─── Route-level test ───────────────────────────────────────────────────────

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessOrgOverview: vi.fn((role: string | undefined) => role === 'admin'),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/pulse/code/org-summary/route');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  route = await import('../app/api/pulse/code/org-summary/route');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
  await sql.exec(`DELETE FROM code_assistant_meta;
           DELETE FROM code_session_stats;
           DELETE FROM code_metrics;
           DELETE FROM config WHERE key = 'code_model_rates';`);
});

async function seedMeta(id: string, opts: { model: string; occurredAt: number; inputTokens?: number; outputTokens?: number }) {
  await sql.run(`INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens, occurred_at, ingested_at)
     VALUES (?, 'user-1', 'sess-1', ?, ?, ?, ?, ?)`, [id, opts.model, opts.inputTokens ?? 100000, opts.outputTokens ?? 50000, opts.occurredAt, NOW]);
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pulse/code/org-summary');
}

describe('GET /api/pulse/code/org-summary — spendProjection', () => {
  it('returns a positive projected spend when there is priced spend in the last 7 days, across two priced models', async () => {
    // Two default-rate models (see lib/pulse/code/rates.ts DEFAULT_RATES).
    await seedMeta('m1', { model: 'claude-sonnet-4-6', occurredAt: NOW - 2 * DAY });
    await seedMeta('m2', { model: 'claude-haiku-4-5', occurredAt: NOW - 3 * DAY });
    // Older month-to-date spend outside the 7-day window but inside the month.
    await seedMeta('m3', { model: 'claude-sonnet-4-6', occurredAt: NOW - 10 * DAY });

    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.spendProjection).not.toBeNull();
    expect(data.spendProjection.projected).toBeGreaterThan(0);
    expect(typeof data.spendProjection.daysElapsed).toBe('number');
    expect(typeof data.spendProjection.daysInMonth).toBe('number');
  });

  it('returns null when there is no priced spend in the last 7 days', async () => {
    // No code_assistant_meta rows seeded at all.
    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spendProjection).toBeNull();
  });

  it('returns null when the only recent activity is on an unpriced model', async () => {
    await seedMeta('m-unpriced', { model: 'made-up-model-unpriced', occurredAt: NOW - 1 * DAY });

    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spendProjection).toBeNull();
  });
});

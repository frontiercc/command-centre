// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { clearKeptFigures } from '@/lib/kept-figures';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

// ─── Pure-function tests (no DB) ────────────────────────────────────────────
//
// On 2026-11-15 the owner chose to make Developer Pulse's month-end projection match FinOps's,
// so the two pages never project differently: month-to-date priced spend divided by the exact
// share of the month gone by (buildFinopsProjection). The earlier tests here pinned the trailing
// 7-day run rate as deliberate; that rule is retired. monthDayCount now supplies the
// day count FinOps shows, so its day count is what is pinned below.

import { monthDayCount } from '@/lib/pulse/code/projection';
import { buildFinopsProjection } from '@/lib/finance/finops-projection';

function utcEpoch(y: number, m: number, d: number, h = 12): number {
  return Math.floor(Date.UTC(y, m - 1, d, h) / 1000);
}

describe('monthDayCount', () => {
  it('mid-month: day 15 of 30', () => {
    const result = monthDayCount(utcEpoch(2026, 6, 15));
    expect(result.daysElapsed).toBe(15);
    expect(result.daysInMonth).toBe(30);
  });

  it('last day of month: day 30 of 30', () => {
    const result = monthDayCount(utcEpoch(2026, 6, 30));
    expect(result.daysElapsed).toBe(30);
    expect(result.daysInMonth).toBe(30);
  });

  it('handles leap February day count (2028 is a leap year)', () => {
    const result = monthDayCount(utcEpoch(2028, 2, 10));
    expect(result.daysInMonth).toBe(29);
    expect(result.daysElapsed).toBe(10);
  });

  it('handles non-leap February day count (2027 is not a leap year)', () => {
    expect(monthDayCount(utcEpoch(2027, 2, 10)).daysInMonth).toBe(28);
  });
});

describe("Developer Pulse's projection rule (FinOps's method)", () => {
  it('divides month-to-date spend by the exact share of the month gone by', () => {
    // 2026-06-15 12:00 UTC: 14.5 of June's 30 days have passed.
    const p = buildFinopsProjection(100, true, utcEpoch(2026, 6, 15))!;
    expect(p.projected).toBeCloseTo(100 / (14.5 / 30), 6);
    expect(p.daysElapsed).toBe(15);
    expect(p.daysInMonth).toBe(30);
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

const DAY = 24 * 60 * 60;
// A fixed "now", so the month-to-date rule never depends on the day the tests run.
const MID_JUNE = utcEpoch(2026, 6, 15);
const SECOND_OF_JUNE = utcEpoch(2026, 6, 2);

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

afterEach(() => { vi.useRealTimers(); });

/** Fake only Date, so the database driver's own timers keep running. */
function at(epochS: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(epochS * 1000));
}

const TOKENS = { inputTokens: 100000, outputTokens: 50000 };

async function seedMeta(id: string, opts: { model: string; occurredAt: number }) {
  await sql.run(`INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens, occurred_at, ingested_at)
     VALUES (?, 'user-1', 'sess-1', ?, ?, ?, ?, ?)`, [id, opts.model, TOKENS.inputTokens, TOKENS.outputTokens, opts.occurredAt, opts.occurredAt]);
}

async function priced(model: string): Promise<number> {
  const { getCodeModelRates, priceTokens } = await import('@/lib/pulse/code/rates');
  return priceTokens(model, { ...TOKENS, cacheCreationTokens: 0, cacheReadTokens: 0 }, await getCodeModelRates())!;
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pulse/code/org-summary');
}

describe('GET /api/pulse/code/org-summary — spendProjection', () => {
  it('projects month-to-date priced spend over the share of the month gone by, as FinOps does', async () => {
    // Two default-rate models (see lib/pulse/code/rates.ts DEFAULT_RATES), all inside June.
    await seedMeta('m1', { model: 'claude-sonnet-4-6', occurredAt: MID_JUNE - 2 * DAY });
    await seedMeta('m2', { model: 'claude-haiku-4-5', occurredAt: MID_JUNE - 3 * DAY });
    // Inside the month, outside the last 7 days: counts, as month-to-date spend.
    await seedMeta('m3', { model: 'claude-sonnet-4-6', occurredAt: MID_JUNE - 10 * DAY });
    // May: not month-to-date, so left out.
    await seedMeta('m4', { model: 'claude-sonnet-4-6', occurredAt: MID_JUNE - 20 * DAY });
    const mtd = 2 * (await priced('claude-sonnet-4-6')) + (await priced('claude-haiku-4-5'));

    at(MID_JUNE);
    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.spendProjection.projected).toBeCloseTo(buildFinopsProjection(mtd, true, MID_JUNE)!.projected, 6);
    expect(data.spendProjection.projected).toBeCloseTo(mtd / (14.5 / 30), 6);
    expect(data.spendProjection.daysElapsed).toBe(15);
    expect(data.spendProjection.daysInMonth).toBe(30);
  });

  it('returns null with spend in the last 7 days but none yet this month', async () => {
    // The retired 7-day run rate projected from this; month-to-date has nothing to go on.
    await seedMeta('m-may', { model: 'claude-sonnet-4-6', occurredAt: SECOND_OF_JUNE - 3 * DAY });
    at(SECOND_OF_JUNE);
    const data = await (await route.GET(makeRequest())).json();
    expect(data.spendProjection).toBeNull();
  });

  it('returns null before day 7 of the month, as FinOps does, even with spend this month', async () => {
    const sixthOfJune = utcEpoch(2026, 6, 6);
    await seedMeta('m-early', { model: 'claude-sonnet-4-6', occurredAt: sixthOfJune - 2 * DAY });
    at(sixthOfJune);
    expect((await (await route.GET(makeRequest())).json()).spendProjection).toBeNull();
    // From day 7 it is shown. The figures are kept between visits, so start from none, as a visit
    // the next day would after the background refresh.
    clearKeptFigures();
    at(utcEpoch(2026, 6, 7));
    expect((await (await route.GET(makeRequest())).json()).spendProjection).not.toBeNull();
  });

  it('returns null when there is no priced spend at all', async () => {
    at(MID_JUNE);
    const data = await (await route.GET(makeRequest())).json();
    expect(data.spendProjection).toBeNull();
  });

  it('returns null when the only activity this month is on an unpriced model', async () => {
    await seedMeta('m-unpriced', { model: 'made-up-model-unpriced', occurredAt: MID_JUNE - 1 * DAY });
    at(MID_JUNE);
    const data = await (await route.GET(makeRequest())).json();
    expect(data.spendProjection).toBeNull();
  });
});

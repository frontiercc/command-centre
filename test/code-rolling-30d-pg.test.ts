// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse's headline window: the hourly aggregator writes the last 30
// days ('rolling'), the 30 days before them ('rolling_prior') and the last 7
// days ('rolling_7d', for the weekly readers), in code_metrics and, once Codex
// data exists, code_metrics_vendor for every product view. The org-summary and
// me routes read priorMetrics from the 'rolling_prior' rows, never from an old
// 'rolling' row. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin-1' }),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

interface MetricRow {
  granularity: string; period_start: number | string; period_end: number | string;
  session_count: number; commit_count: number; computed_at: number | string;
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await seedUserSql(sql, 'user-1');
});
afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_assistant_meta; DELETE FROM code_session_stats; DELETE FROM code_metrics;
    DELETE FROM code_metrics_vendor; DELETE FROM cowork_messages; DELETE FROM codex_actions;`);
  // Nothing to roll up: the sessions below are seeded straight into code_session_stats.
  const { setConfigValue } = await import('@/lib/config');
  await setConfigValue('codeAggregatorLastRun', new Date().toISOString());
  await setConfigValue('codeVendorWeeksChangedSince', '0');
});

async function seedSession(id: string, daysAgo: number, commits: number) {
  const at = NOW - daysAgo * DAY;
  await sql.run(
    `INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, tool_use_count, commit_count, computed_at)
     VALUES (?, 'user-1', ?, ?, 1, 2, ?, ?)`,
    [id, at - 600, at, commits, NOW],
  );
}

async function orgRows(table: 'code_metrics' | 'code_metrics_vendor', vendor?: string): Promise<Record<string, MetricRow>> {
  const rows = (await sql.all(
    `SELECT granularity, period_start, period_end, session_count, commit_count, computed_at FROM ${table}
     WHERE scope_type = 'organisation' AND granularity <> 'week' ${vendor ? `AND vendor = '${vendor}'` : ''}`,
  )) as MetricRow[];
  return Object.fromEntries(rows.map(r => [r.granularity, r]));
}

const span = (r: MetricRow) => Number(r.period_end) - Number(r.period_start);

async function route(path: string) {
  const mod = path.startsWith('/api/pulse/code/me')
    ? await import('../app/api/pulse/code/me/route')
    : await import('../app/api/pulse/code/org-summary/route');
  const res = await mod.GET(new NextRequest(`http://localhost${path}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe('runCodeHourlyAggregation: 30-day windows', () => {
  it('writes the last 30 days, the 30 days before and the last 7 days as their own rows', async () => {
    await seedSession('cc-2d', 2, 1);   // last 7 days, last 30 days
    await seedSession('cc-20d', 20, 2); // last 30 days only
    await seedSession('cc-45d', 45, 4); // the 30 days before
    await seedSession('cc-70d', 70, 8); // outside every window

    const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
    await runCodeHourlyAggregation();

    const org = await orgRows('code_metrics');
    expect(Object.keys(org).sort()).toEqual(['rolling', 'rolling_7d', 'rolling_prior']);

    expect(span(org.rolling)).toBe(30 * DAY);
    expect(org.rolling).toMatchObject({ session_count: 2, commit_count: 3 });

    expect(span(org.rolling_prior)).toBe(30 * DAY);
    expect(Number(org.rolling_prior.period_end)).toBe(Number(org.rolling.period_start));
    expect(org.rolling_prior).toMatchObject({ session_count: 1, commit_count: 4 });

    expect(span(org.rolling_7d)).toBe(7 * DAY);
    expect(org.rolling_7d).toMatchObject({ session_count: 1, commit_count: 1 });

    // The person's own rows, for My Developer Pulse and the Users list. The calendar-week row is
    // left out, as orgRows does: whether a session two days ago falls in this week depends on the
    // day the test runs (on a Monday or Tuesday it is last week).
    const user = (await sql.all(
      `SELECT granularity, session_count, commit_count FROM code_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' AND granularity <> 'week' ORDER BY granularity`,
    )) as Array<{ granularity: string; session_count: number; commit_count: number }>;
    expect(user.map(r => [r.granularity, r.session_count, r.commit_count])).toEqual([
      ['rolling', 2, 3], ['rolling_7d', 1, 1], ['rolling_prior', 1, 4],
    ]);
  });

  it('reads priorMetrics from the 30 days before, for the organisation and for a person', async () => {
    await seedSession('cc-2d', 2, 1);
    await seedSession('cc-20d', 20, 2);
    await seedSession('cc-45d', 45, 4);
    const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
    await runCodeHourlyAggregation();

    const org = await route('/api/pulse/code/org-summary');
    expect(org.metrics).toMatchObject({ session_count: 2, commit_count: 3 });
    expect(org.priorMetrics).toMatchObject({ session_count: 1, commit_count: 4 });

    const me = await route('/api/pulse/code/me?userId=user-1');
    expect(me.metrics).toMatchObject({ session_count: 2, commit_count: 3 });
    expect(me.priorMetrics).toMatchObject({ session_count: 1, commit_count: 4 });
  });

  it('has no priorMetrics when nothing happened in the 30 days before, and never reads an old rolling row as them', async () => {
    await seedSession('cc-2d', 2, 1);
    // An old snapshot of the kind written before the 30-day windows: not the 30 days before.
    await sql.run(
      `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, session_count, commit_count, spend_usd, granularity, computed_at)
       VALUES ('organisation', 'org', ?, ?, 9, 9, 9, 'rolling', ?)`,
      [NOW - 17 * DAY, NOW - 10 * DAY, NOW - 10 * DAY],
    );
    const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
    await runCodeHourlyAggregation();

    expect((await orgRows('code_metrics')).rolling_prior).toMatchObject({ session_count: 0 });
    const org = await route('/api/pulse/code/org-summary');
    expect(org.metrics).toMatchObject({ session_count: 1, commit_count: 1 });
    expect(org.priorMetrics).toBeNull();
    const me = await route('/api/pulse/code/me?userId=user-1');
    expect(me.priorMetrics).toBeNull();
  });

  it('writes the same three windows for every product view once Codex data exists', async () => {
    await seedSession('cc-2d', 2, 1);
    await seedSession('cc-45d', 45, 4);
    await seedSession('codex:s45', 45, 0);
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at, ingested_at)
       VALUES ('cx-1', 'codex:s45', 'user-1', 'code_user_message', 'code', 'codex', ?, ?)`,
      [NOW - 45 * DAY, NOW - 45 * DAY],
    );
    const { runCodeHourlyAggregation } = await import('@/lib/pulse/code/aggregator');
    await runCodeHourlyAggregation();

    const all = await orgRows('code_metrics_vendor', 'all');
    const claude = await orgRows('code_metrics_vendor', 'claude');
    const openai = await orgRows('code_metrics_vendor', 'openai');
    for (const v of [all, claude, openai]) {
      expect(Object.keys(v).sort()).toEqual(['rolling', 'rolling_7d', 'rolling_prior']);
      expect(span(v.rolling)).toBe(30 * DAY);
      expect(span(v.rolling_prior)).toBe(30 * DAY);
      expect(span(v.rolling_7d)).toBe(7 * DAY);
    }
    expect([all.rolling_prior.session_count, claude.rolling_prior.session_count, openai.rolling_prior.session_count]).toEqual([2, 1, 1]);
    expect([all.rolling.session_count, claude.rolling.session_count, openai.rolling.session_count]).toEqual([1, 1, 0]);
    expect(claude.rolling_prior.commit_count).toBe(4);
  });
});

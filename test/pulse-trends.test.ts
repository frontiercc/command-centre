// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getWeeklySeries: typeof import('@/lib/pulse/trends').getWeeklySeries;
let getWeeklyDelta: typeof import('@/lib/pulse/trends').getWeeklyDelta;
let weekStart: typeof import('@/lib/pulse/period').weekStart;
let weekStarts: typeof import('@/lib/pulse/period').weekStarts;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const trends = await import('@/lib/pulse/trends');
  getWeeklySeries = trends.getWeeklySeries;
  getWeeklyDelta = trends.getWeeklyDelta;

  const period = await import('@/lib/pulse/period');
  weekStart = period.weekStart;
  weekStarts = period.weekStarts;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics;`);

  const weeks = weekStarts(NOW, 4); // [4wk ago .. current week], ascending
  const currentWeekStart = weeks[3];
  const priorWeekStart = weeks[2]; // 1 week ago (completed)
  const twoWeeksAgoStart = weeks[1]; // 2 weeks ago (completed)
  // weeks[0] (3 weeks / 4th-most-recent) intentionally left with no row -> null

  const insertWeek = (...params: number[]) => sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, spend_usd,
       input_tokens, output_tokens, session_count, commit_count,
       granularity, computed_at
     ) VALUES ('organisation', 'org', ?, ?, ?, 0, 0, 0, 0, 'week', ?)`,
    params,
  );

  // Two completed weeks: 100 then 130 (ascending chronological order)
  await insertWeek(twoWeeksAgoStart, twoWeeksAgoStart + 1, 100, NOW);
  await insertWeek(priorWeekStart, priorWeekStart + 1, 130, NOW);
  // Current (partial) week
  await insertWeek(currentWeekStart, NOW, 20, NOW);

  // Decoy rolling row at the current week start — must be ignored
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, spend_usd,
       input_tokens, output_tokens, session_count, commit_count,
       granularity, computed_at
     ) VALUES ('organisation', 'org', ?, ?, 999999, 0, 0, 0, 0, 'rolling', ?)`,
    [currentWeekStart, NOW, NOW],
  );
});

describe('getWeeklySeries', () => {
  it('returns one entry per calendar week, marks current week partial, ignores rolling rows', async () => {
    const s = await getWeeklySeries('code_metrics', 'organisation', 'org', 'spend_usd', 4);
    expect(s).toHaveLength(4);
    expect(s[0].value).toBeNull(); // no data 4 weeks ago
    expect(s[0].partial).toBe(false);
    expect(s[1].value).toBe(100);
    expect(s[2].value).toBe(130);
    expect(s[3]).toMatchObject({ value: 20, partial: true });
    expect(s[3].weekStart).toBe(weekStart(NOW));
  });
});

describe('getWeeklyDelta', () => {
  it('compares the two most recent completed weeks, never the partial week', async () => {
    const d = await getWeeklyDelta('code_metrics', 'organisation', 'org', 'spend_usd', 4);
    expect(d.current).toBe(130);
    expect(d.prior).toBe(100);
    expect(d.pct).toBeCloseTo(0.3);
  });

  it('returns null pct when prior is null or 0', async () => {
    await sql.exec(`DELETE FROM code_metrics WHERE spend_usd = 100`);
    const d = await getWeeklyDelta('code_metrics', 'organisation', 'org', 'spend_usd', 4);
    expect(d.current).toBe(130);
    expect(d.prior).toBeNull();
    expect(d.pct).toBeNull();
  });

  it('rejects a column not on the allowlist', async () => {
    await expect(getWeeklySeries('code_metrics', 'organisation', 'org', 'computed_at; DROP TABLE x', 4)).rejects.toThrow();
    await expect(getWeeklyDelta('code_metrics', 'organisation', 'org', 'computed_at; DROP TABLE x', 4)).rejects.toThrow();
  });

  it('rejects a column not on the pulse_metrics allowlist', async () => {
    await expect(getWeeklySeries('pulse_metrics', 'user', 'user-1', 'spend_usd', 4)).rejects.toThrow();
  });
});

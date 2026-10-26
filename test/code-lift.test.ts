// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let computeObservedLift: typeof import('@/lib/pulse/code/lift').computeObservedLift;
let weekStarts: typeof import('@/lib/pulse/period').weekStarts;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const lift = await import('@/lib/pulse/code/lift');
  computeObservedLift = lift.computeObservedLift;

  const period = await import('@/lib/pulse/period');
  weekStarts = period.weekStarts;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics;`);
});

const insertWeek = async (
  sql: TestSql,
  periodStart: number,
  activeTimeUserS: number,
  commitCount: number,
  computedAt: number,
) => {
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end,
       active_time_user_s, commit_count,
       input_tokens, output_tokens, session_count,
       granularity, computed_at
     ) VALUES ('organisation', 'org', ?, ?, ?, ?, 0, 0, 0, 'week', ?)`,
    [periodStart, periodStart + 1, activeTimeUserS, commitCount, computedAt],
  );
};

describe('computeObservedLift', () => {
  it('computes ~0.25 lift when high-AI weeks average 10 commits and low-AI weeks average 8', async () => {
    // 9 weeks so we can drop the trailing partial week and keep 8 completed weeks.
    const weeks = weekStarts(NOW, 9);
    const completed = weeks.slice(0, 8); // drop current partial week

    // Low-AI-time half (4 weeks): active_time 1000s, commits 8 each -> mean 8
    // High-AI-time half (4 weeks): active_time 5000s, commits 10 each -> mean 10
    for (const [i, ws] of completed.entries()) {
      const isHigh = i >= 4;
      await insertWeek(sql, ws, isHigh ? 5000 : 1000, isHigh ? 10 : 8, NOW);
    }

    const result = await computeObservedLift();
    expect(result).not.toBeNull();
    expect(result!.liftPct).toBeCloseTo(0.25, 5);
    expect(result!.highWeeks).toBe(4);
    expect(result!.lowWeeks).toBe(4);
  });

  it('returns null with fewer than 6 completed weeks of activity', async () => {
    const weeks = weekStarts(NOW, 6);
    const completed = weeks.slice(0, 5); // only 5 completed weeks

    for (const [i, ws] of completed.entries()) {
      const isHigh = i >= 3;
      await insertWeek(sql, ws, isHigh ? 5000 : 1000, isHigh ? 10 : 8, NOW);
    }

    expect(await computeObservedLift()).toBeNull();
  });

  it('returns null when the low-half commit mean is zero', async () => {
    const weeks = weekStarts(NOW, 9);
    const completed = weeks.slice(0, 8);

    for (const [i, ws] of completed.entries()) {
      const isHigh = i >= 4;
      await insertWeek(sql, ws, isHigh ? 5000 : 1000, isHigh ? 10 : 0, NOW);
    }

    expect(await computeObservedLift()).toBeNull();
  });

  it('excludes the current partial week from consideration', async () => {
    const weeks = weekStarts(NOW, 9);
    const completed = weeks.slice(0, 8);
    const currentWeek = weeks[8];

    for (const [i, ws] of completed.entries()) {
      const isHigh = i >= 4;
      await insertWeek(sql, ws, isHigh ? 5000 : 1000, isHigh ? 10 : 8, NOW);
    }
    // Partial current week with wildly different numbers — must be excluded.
    await insertWeek(sql, currentWeek, 999999, 999, NOW);

    const result = await computeObservedLift();
    expect(result).not.toBeNull();
    expect(result!.liftPct).toBeCloseTo(0.25, 5);
  });

  it('ignores rolling rows and non-organisation scopes', async () => {
    const weeks = weekStarts(NOW, 9);
    const completed = weeks.slice(0, 8);

    for (const [i, ws] of completed.entries()) {
      const isHigh = i >= 4;
      await insertWeek(sql, ws, isHigh ? 5000 : 1000, isHigh ? 10 : 8, NOW);
    }

    // Decoy rolling row + decoy user-scope row — must not affect the result.
    await sql.run(
      `INSERT INTO code_metrics (
         scope_type, scope_id, period_start, period_end,
         active_time_user_s, commit_count, input_tokens, output_tokens, session_count,
         granularity, computed_at
       ) VALUES ('organisation', 'org', ?, ?, 999999, 999, 0, 0, 0, 'rolling', ?)`,
      [weeks[7], NOW, NOW],
    );
    await sql.run(
      `INSERT INTO code_metrics (
         scope_type, scope_id, period_start, period_end,
         active_time_user_s, commit_count, input_tokens, output_tokens, session_count,
         granularity, computed_at
       ) VALUES ('user', 'user-1', ?, ?, 999999, 999, 0, 0, 0, 'week', ?)`,
      [weeks[7], weeks[7] + 1, NOW],
    );

    const result = await computeObservedLift();
    expect(result).not.toBeNull();
    expect(result!.liftPct).toBeCloseTo(0.25, 5);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the granularity filter sweep.
 *
 * Migration 053 added `granularity` ('rolling' default | 'week') rows to
 * code_metrics and pulse_metrics. Every PRE-EXISTING reader of these tables
 * ("latest row" ORDER BY computed_at DESC LIMIT 1, MAX(computed_at)
 * subqueries, windowed AVGs) was written before that column existed, so
 * without an explicit `AND granularity = 'rolling'` filter they also match
 * weekly trend rows — which have different semantics (partial calendar week;
 * cowork weekly rows have NULL oti/psr/ors; backfilled weekly code rows can
 * have NULL autonomy). Observed symptom: /pulse/code showed "No activity to
 * judge yet" because the org-summary latest-row read picked a weekly row
 * whose autonomy_ratio was NULL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);
const ORG_SCOPE_ID = 'org';

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics;`);
  await sql.exec(`DELETE FROM pulse_metrics;`);
});

/** One rolling org row (autonomy 2.5, older) + one NEWER weekly org row (autonomy NULL). */
async function seedCodeMetrics() {
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end,
       spend_usd, autonomy_ratio, session_count, commit_count,
       granularity, computed_at
     ) VALUES ('organisation', ?, ?, ?, 10.0, 2.5, 4, 6, 'rolling', ?)`,
    [ORG_SCOPE_ID, NOW - 7 * 86400, NOW, NOW - 60],
  );
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end,
       spend_usd, autonomy_ratio, session_count, commit_count,
       granularity, computed_at
     ) VALUES ('organisation', ?, ?, ?, 3.0, NULL, 1, 1, 'week', ?)`,
    [ORG_SCOPE_ID, NOW - 3 * 86400, NOW, NOW],
  );
}

/** One rolling user row (dds 2.5, older) + one NEWER weekly user row (oti NULL). */
async function seedPulseMetrics() {
  await sql.run(
    `INSERT INTO pulse_metrics (
       scope_type, scope_id, period_start, period_end,
       dds, oti, event_count, granularity, computed_at
     ) VALUES ('user', 'u1', ?, ?, 2.5, 1.8, 10, 'rolling', ?)`,
    [NOW - 7 * 86400, NOW, NOW - 60],
  );
  await sql.run(
    `INSERT INTO pulse_metrics (
       scope_type, scope_id, period_start, period_end,
       dds, oti, event_count, granularity, computed_at
     ) VALUES ('user', 'u1', ?, ?, 1.0, NULL, 2, 'week', ?)`,
    [NOW - 3 * 86400, NOW, NOW],
  );
}

describe('granularity filter — code_metrics rolling readers', () => {
  it('UNfiltered latest-row query picks the weekly row (demonstrates the bug the filter fixes)', async () => {
    await seedCodeMetrics();
    // Pre-fix query shape: no granularity clause — the newer weekly row wins
    // and its NULL autonomy_ratio makes the org autonomy verdict render as
    // "No activity to judge yet".
    const row = (await sql.get<{ autonomy_ratio: number | null; spend_usd: number | null }>(
      `SELECT autonomy_ratio, spend_usd
       FROM code_metrics
       WHERE scope_type = 'organisation' AND scope_id = ?
       ORDER BY computed_at DESC LIMIT 1`,
      [ORG_SCOPE_ID],
    ))!;

    expect(row.autonomy_ratio).toBeNull(); // the weekly row — wrong semantics
    expect(row.spend_usd).toBe(3.0);
  });

  it('org-summary latest-row read (exact patched SQL) returns the rolling row', async () => {
    await seedCodeMetrics();
    // Exact query from app/api/pulse/code/org-summary/route.ts after the fix.
    const row = (await sql.get<{ autonomy_ratio: number | null; spend_usd: number | null; computed_at: number }>(
      `SELECT spend_usd, input_tokens, output_tokens, cache_hit_ratio,
              autonomy_ratio, session_count, repo_count, commit_count,
              skill_leverage, friction_index,
              active_time_user_s, active_time_cli_s, lines_added, lines_removed,
              pr_count, edit_accept_count, edit_reject_count,
              period_start, period_end, computed_at
       FROM code_metrics
       WHERE scope_type = 'organisation' AND scope_id = ? AND granularity = 'rolling'
       ORDER BY computed_at DESC LIMIT 1`,
      [ORG_SCOPE_ID],
    ))!;

    expect(row).toBeDefined();
    expect(row.autonomy_ratio).toBe(2.5); // the rolling row, despite being older
    expect(row.spend_usd).toBe(10.0);
    expect(row.computed_at).toBe(NOW - 60);
  });
});

describe('granularity filter — pulse_metrics rolling readers', () => {
  it('UNfiltered latest-row query picks the weekly row (demonstrates the bug the filter fixes)', async () => {
    await seedPulseMetrics();
    const row = (await sql.get<{ oti: number | null; dds: number | null }>(
      `SELECT oti, dds FROM pulse_metrics
       WHERE scope_type = 'user' AND scope_id = ?
       ORDER BY computed_at DESC LIMIT 1`,
      ['u1'],
    ))!;

    expect(row.oti).toBeNull(); // weekly cowork rows carry NULL oti
    expect(row.dds).toBe(1.0);
  });

  it('me-route latest-row read (exact patched SQL) returns the rolling row', async () => {
    await seedPulseMetrics();
    // Exact query from app/api/pulse/me/route.ts after the fix.
    const row = (await sql.get<{ oti: number | null; dds: number | null; computed_at: number }>(
      `SELECT oti, dds, psr, ors, event_count,
              tier_1_count, tier_2_count, tier_3_count, computed_at
       FROM pulse_metrics
       WHERE scope_type = 'user' AND scope_id = ? AND granularity = 'rolling'
       ORDER BY computed_at DESC LIMIT 1`,
      ['u1'],
    ))!;

    expect(row).toBeDefined();
    expect(row.dds).toBe(2.5);
    expect(row.oti).toBe(1.8);
    expect(row.computed_at).toBe(NOW - 60);
  });

  it('MAX(computed_at) per-scope subquery (exact patched SQL from depts route) resolves to the rolling row', async () => {
    await seedPulseMetrics();
    // Exact subquery shape from app/api/pulse/depts/route.ts after the fix —
    // both the outer WHERE and the inner MAX(computed_at) filter on granularity.
    const rows = await sql.all<{ user_id: string; dds: number | null; oti: number | null }>(
      `SELECT scope_id AS user_id, dds, oti
       FROM pulse_metrics
       WHERE scope_type = 'user' AND granularity = 'rolling'
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM pulse_metrics
           WHERE scope_type = 'user' AND granularity = 'rolling'
           GROUP BY scope_id
         )`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('u1');
    expect(rows[0].dds).toBe(2.5);
    expect(rows[0].oti).toBe(1.8);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let runRetentionCleanup: typeof import('@/lib/retention/cleanup').runRetentionCleanup;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/retention/cleanup');
  runRetentionCleanup = mod.runRetentionCleanup;
});

afterAll(async () => { await cleanup(); });

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics;
           DELETE FROM pulse_metrics;
           DELETE FROM config WHERE key = 'archive_enabled';`);
});

describe('runRetentionCleanup — granularity-aware metric pruning', () => {
  it('prunes rolling rows older than 30d, keeps weekly rows up to 400d, deletes 401d+', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldRolling40d = nowSeconds - (40 * 86400);
    const oldWeekly40d = nowSeconds - (40 * 86400);
    const recentRolling = nowSeconds - (10 * 86400);
    const oldWeekly401d = nowSeconds - (401 * 86400);

    // Seed code_metrics
    await sql.run(`
      INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('user', 'user1', ?, ?, 'rolling', ?, 10.5)
    `, [oldRolling40d, oldRolling40d + 3600, oldRolling40d]);

    await sql.run(`
      INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('user', 'user1', ?, ?, 'week', ?, 50.0)
    `, [oldWeekly40d, oldWeekly40d + 604800, oldWeekly40d]);

    await sql.run(`
      INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('user', 'user1', ?, ?, 'rolling', ?, 15.0)
    `, [recentRolling, recentRolling + 3600, recentRolling]);

    await sql.run(`
      INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('user', 'user1', ?, ?, 'week', ?, 60.0)
    `, [oldWeekly401d, oldWeekly401d + 604800, oldWeekly401d]);

    // Seed pulse_metrics
    await sql.run(`
      INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, event_count)
      VALUES ('user', 'user1', ?, ?, 'rolling', ?, 5)
    `, [oldRolling40d, oldRolling40d + 3600, oldRolling40d]);

    await sql.run(`
      INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, event_count)
      VALUES ('user', 'user1', ?, ?, 'week', ?, 20)
    `, [oldWeekly40d, oldWeekly40d + 604800, oldWeekly40d]);

    await sql.run(`
      INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, event_count)
      VALUES ('user', 'user1', ?, ?, 'rolling', ?, 8)
    `, [recentRolling, recentRolling + 3600, recentRolling]);

    await sql.run(`
      INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, event_count)
      VALUES ('user', 'user1', ?, ?, 'week', ?, 25)
    `, [oldWeekly401d, oldWeekly401d + 604800, oldWeekly401d]);

    // Exercise the REAL function — archiveEnabled is unset (not 'true'), so
    // the archive step is skipped and cleanup runs straight through.
    await runRetentionCleanup();

    const codeMetricsAfter = (await sql.all('SELECT * FROM code_metrics ORDER BY computed_at')) as Array<{
      granularity: string;
      computed_at: number;
    }>;

    const pulseMetricsAfter = (await sql.all('SELECT * FROM pulse_metrics ORDER BY computed_at')) as Array<{
      granularity: string;
      computed_at: number;
    }>;

    // Should have 2 rows: old weekly 40d (KEPT) and recent rolling 10d (KEPT)
    expect(codeMetricsAfter).toHaveLength(2);
    expect(pulseMetricsAfter).toHaveLength(2);

    // Verify old rolling 40d is gone
    const codeOldRolling = codeMetricsAfter.find(r => r.granularity === 'rolling' && r.computed_at === oldRolling40d);
    expect(codeOldRolling).toBeUndefined();

    // Verify old weekly 40d is kept (this was the bug fix)
    const codeOldWeekly40 = codeMetricsAfter.find(r => r.granularity === 'week' && r.computed_at === oldWeekly40d);
    expect(codeOldWeekly40).toBeDefined();

    // Verify recent rolling is kept
    const codeRecentRolling = codeMetricsAfter.find(r => r.granularity === 'rolling' && r.computed_at === recentRolling);
    expect(codeRecentRolling).toBeDefined();

    // Verify old weekly 401d is deleted
    const codeOldWeekly401 = codeMetricsAfter.find(r => r.granularity === 'week' && r.computed_at === oldWeekly401d);
    expect(codeOldWeekly401).toBeUndefined();

    // Same checks for pulse_metrics
    const pulseOldRolling = pulseMetricsAfter.find(r => r.granularity === 'rolling' && r.computed_at === oldRolling40d);
    expect(pulseOldRolling).toBeUndefined();

    const pulseOldWeekly40 = pulseMetricsAfter.find(r => r.granularity === 'week' && r.computed_at === oldWeekly40d);
    expect(pulseOldWeekly40).toBeDefined();

    const pulseRecentRolling = pulseMetricsAfter.find(r => r.granularity === 'rolling' && r.computed_at === recentRolling);
    expect(pulseRecentRolling).toBeDefined();

    const pulseOldWeekly401 = pulseMetricsAfter.find(r => r.granularity === 'week' && r.computed_at === oldWeekly401d);
    expect(pulseOldWeekly401).toBeUndefined();
  });

  it('prunes future-dated metric rows (poison rows that win MAX(computed_at) tiles)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const future = nowSeconds + (350 * 86400); // ~350d ahead — the seed bug we hit on the demo deployment
    const recentRolling = nowSeconds - (5 * 86400);

    // A valid recent row + a corrupt future-dated row for the same scope.
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('function', 'Engineering', ?, ?, 'rolling', ?, 1.07)`, [recentRolling, recentRolling + 3600, recentRolling]);
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, spend_usd)
      VALUES ('function', 'Engineering', ?, ?, 'rolling', ?, 0)`, [future, future + 3600, future]);
    await sql.run(`INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, granularity, computed_at, event_count)
      VALUES ('function', 'Engineering', ?, ?, 'rolling', ?, 0)`, [future, future + 3600, future]);

    await runRetentionCleanup();

    // The future-dated rows are gone; the valid recent row survives and now wins the tile.
    expect(((await sql.get('SELECT COUNT(*) c FROM code_metrics WHERE computed_at > ?', [nowSeconds])) as { c: number }).c).toBe(0);
    expect(((await sql.get('SELECT COUNT(*) c FROM pulse_metrics WHERE computed_at > ?', [nowSeconds])) as { c: number }).c).toBe(0);
    const winner = (await sql.get("SELECT spend_usd FROM code_metrics WHERE scope_type='function' AND scope_id='Engineering' AND granularity='rolling' ORDER BY computed_at DESC LIMIT 1")) as { spend_usd: number } | undefined;
    expect(winner?.spend_usd).toBe(1.07);
  });
});

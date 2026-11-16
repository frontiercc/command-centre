// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse's period panel reads the same rows as the other readers:
// once Codex data exists, All is the all-tools row of code_metrics_vendor
// (Claude Code plus Codex), never code_metrics. With no Codex data, or with
// OpenAI hidden (the route asks for Claude), the panel still has figures.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TestSql } from './helpers/sql';
import { createTestDatabase } from './helpers/db';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildCodePeriodWork: typeof import('@/lib/pulse/code/period-work').buildCodePeriodWork;
const DEPT = 'Engineering';
const NOW = Math.floor(Date.now() / 1000);

function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}
const WEEK_START = mondayOf(NOW);

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  ({ buildCodePeriodWork } = await import('@/lib/pulse/code/period-work'));
});
afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics; DELETE FROM code_metrics_vendor; DELETE FROM cowork_messages;`);
  // code_metrics: Claude Code alone, as before Codex arrived.
  await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, granularity, period_start, period_end, session_count, commit_count,
      pr_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
    VALUES ('function', ?, 'week', ?, ?, 5, 4, 1, 3600, 1800, 10, ?)`, [DEPT, WEEK_START, NOW, NOW]);
});

async function seedCodex() {
  await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, occurred_at, ingested_at)
    VALUES ('cx-1', NULL, 'codex:s', 'code_user_message', 'code', 'codex', ?, ?)`, [NOW, NOW]);
  const row = (vendor: string, sessions: number, commits: number, spend: number, userS: number, cliS: number) => sql.run(
    `INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, granularity, period_start, period_end, session_count,
       commit_count, pr_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
     VALUES (?, 'function', ?, 'week', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [vendor, DEPT, WEEK_START, NOW, sessions, commits, userS, cliS, spend, NOW]);
  await row('claude', 5, 4, 10, 3600, 1800);
  await row('openai', 3, 2, 6, 0, 0);
  await row('all', 8, 6, 16, 3600, 1800);
}

const build = (vendor: 'all' | 'claude' | 'openai') =>
  buildCodePeriodWork({ scopeType: 'function', scopeId: DEPT, period: 'week', vendor, nowS: NOW });

describe('buildCodePeriodWork by vendor', () => {
  it('All is Claude Code plus Codex for sessions, commits and spend', async () => {
    await seedCodex();
    const [all, claude, codex] = await Promise.all([build('all'), build('claude'), build('openai')]);
    expect(claude.sessions.now).toBe(5);
    expect(codex.sessions.now).toBe(3);
    expect(all.sessions.now).toBe(claude.sessions.now + codex.sessions.now);
    expect(all.commits.now).toBe(claude.commits.now + codex.commits.now);
    expect(all.spendUsd.now).toBe(claude.spendUsd.now + codex.spendUsd.now);
  });

  it('reads code_metrics before Codex data exists, so a Claude view (OpenAI hidden) is not blank', async () => {
    const claude = await build('claude');
    expect(claude.sessions.now).toBe(5);
    expect(claude.commits.now).toBe(4);
  });

  it('engaged time counts the person and the CLI, in the total and the trend', async () => {
    const w = await build('all');
    expect(w.engagedSecs.now).toBe(5400);
    expect(w.trend.engagedSecs).toEqual([5400]);
  });

  it('the quarter is the 13 completed weeks: this week is left out, last week is in', async () => {
    await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, granularity, period_start, period_end, session_count, commit_count,
        pr_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
      VALUES ('function', ?, 'week', ?, ?, 7, 0, 0, 0, 0, 0, ?)`, [DEPT, WEEK_START - 7 * 86400, WEEK_START, NOW]);
    const q = await buildCodePeriodWork({ scopeType: 'function', scopeId: DEPT, period: 'quarter', vendor: 'claude', nowS: NOW });
    expect(q.label).toBe('Last quarter');
    expect(q.sessions.now).toBe(7);
    expect(q.trend.sessions).toHaveLength(13);
    expect(q.trend.sessions[12]).toBe(7);
  });
});

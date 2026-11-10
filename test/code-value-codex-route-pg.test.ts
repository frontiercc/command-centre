// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse Value page with Codex: once Codex data exists and ChatGPT
// and Codex are shown, Codex's priced turns join the 30-day spend (and the
// annual spend behind the return estimate) and its commits join the measured
// commits, each part returned apart for the measured strip. Unit economics
// stay Claude Code's. Hidden: the page reads as before.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TestSql } from './helpers/sql';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessOrgOverview: vi.fn((role: string | undefined) => role === 'admin'),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/pulse/code/value/route');
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let ORG_SCOPE_ID: string;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  route = await import('../app/api/pulse/code/value/route');
  ({ setConfigValue } = await import('@/lib/config'));
  ({ ORG_SCOPE_ID } = await import('@/lib/pulse/code/aggregator'));
  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
});
afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
  await sql.exec(`DELETE FROM code_assistant_meta; DELETE FROM code_metrics; DELETE FROM code_metrics_vendor;
    DELETE FROM codex_turns; DELETE FROM cowork_messages;
    DELETE FROM config WHERE key IN ('time_saved_min_per_commit', 'timeSavedMinPerCommit');`);
  await setConfigValue('codeValueEnabled', 'true');
  await setConfigValue('openaiShown', 'true');
  // Claude Code: 1M input tokens of claude-sonnet-5 = $2 in the last 30 days
  await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, occurred_at)
    VALUES ('cam-1', 'user-1', 's-1', 'claude-sonnet-5', 1000000, ?)`, [NOW - DAY]);
  // Claude Code's own org row (code_metrics before the aggregator fills the vendor rows)
  await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, granularity, period_start, period_end, commit_count, pr_count,
      session_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
    VALUES ('organisation', ?, 'rolling', ?, ?, 4, 1, 2, 0, 0, 2, ?)`, [ORG_SCOPE_ID, NOW - 7 * DAY, NOW, NOW]);
});

async function seedCodex() {
  // Codex: 1M uncached input tokens of gpt-6 = $2; and a Codex prompt, so Codex data exists
  await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens)
    VALUES ('ct-1', 'user-2', 'codex:s-2', 'gpt-6', ?, 1000000)`, [NOW - DAY]);
  await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, occurred_at, ingested_at)
    VALUES ('cx-1', 'user-2', 'codex:s-2', 'code_user_message', 'code', 'codex', ?, ?)`, [NOW - DAY, NOW]);
  await sql.run(`INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, granularity, period_start, period_end, commit_count, computed_at)
    VALUES ('openai', 'organisation', ?, 'rolling', ?, ?, 3, ?)`, [ORG_SCOPE_ID, NOW - 7 * DAY, NOW, NOW]);
}

function get() {
  return route.GET(new NextRequest('http://localhost/api/pulse/code/value'));
}

describe('GET /api/pulse/code/value with Codex', () => {
  it('reads as before with no Codex data: no split, Claude Code only', async () => {
    const body = await (await get()).json();
    expect(body.split).toBeNull();
    expect(body.measured.spend30d).toBeCloseTo(2, 6);
    expect(body.measured.commitCount).toBe(4);
    expect(body.calibrations.annualSpend.value).toBeCloseTo(2 * 365 / 30, 6);
  });

  it('adds Codex spend and commits, returns the split, keeps unit economics Claude Code only', async () => {
    await seedCodex();
    const body = await (await get()).json();
    expect(body.measured.spend30d).toBeCloseTo(4, 6);
    expect(body.measured.commitCount).toBe(7);
    expect(body.calibrations.annualSpend.value).toBeCloseTo(4 * 365 / 30, 6);
    expect(body.split.claudeCode.commitCount).toBe(4);
    expect(body.split.claudeCode.spend30d).toBeCloseTo(2, 6);
    expect(body.split.codex.commitCount).toBe(3);
    expect(body.split.codex.spend30d).toBeCloseTo(2, 6);
    expect(body.split.codex.unpricedModels).toEqual([]);
    // Claude Code's row spend over Claude Code's commits
    expect(body.measured.costPerCommit).toBeCloseTo(0.5, 6);
  });

  it('counts the from-data team across Claude Code and Codex, each person once', async () => {
    await seedCodex();
    let body = await (await get()).json();
    expect(body.measured.activeUsers).toBe(2);
    expect(body.calibrations.teamSize.value).toBe(2);
    expect(body.split.claudeCode.activeUsers).toBe(1);
    expect(body.split.codex.activeUsers).toBe(1);
    // user-1 also uses Codex: still two people
    await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens)
      VALUES ('ct-2', 'user-1', 'codex:s-3', 'gpt-6', ?, 10)`, [NOW - DAY]);
    body = await (await get()).json();
    expect(body.measured.activeUsers).toBe(2);
    expect(body.split.codex.activeUsers).toBe(2);
    // A Codex turn outside the 30 days does not count
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('user-old', 'old@example.com', 'Old') ON CONFLICT DO NOTHING`);
    await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at) VALUES ('ct-old', 'user-old', 'codex:s-old', 'gpt-6', ?)`, [NOW - 40 * DAY]);
    expect((await (await get()).json()).measured.activeUsers).toBe(2);
  });

  it('Time saved counts commits on the same basis as the Commits figure', async () => {
    await seedCodex();
    const body = await (await get()).json();
    const row = body.timeSaved.rows.find((r: { label: string }) => r.label === 'AI-assisted commits');
    expect(row.count).toBe(body.measured.commitCount);
    expect(row.count).toBe(7);
  });

  it('Observed signal stays Claude Code only: Codex commits have no engaged time to compare against', async () => {
    const { weekStarts } = await import('@/lib/pulse/period');
    const weeks = weekStarts(NOW - 7 * DAY, 6); // completed weeks, ascending
    for (let i = 0; i < 6; i++) {
      await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, granularity, period_start, period_end, commit_count, active_time_user_s, computed_at)
        VALUES ('organisation', ?, 'week', ?, ?, 2, ?, ?)`, [ORG_SCOPE_ID, weeks[i], weeks[i] + 7 * DAY, (i + 1) * 100, NOW]);
    }
    expect((await (await get()).json()).observedLift.liftPct).toBeCloseTo(0, 6); // Claude Code alone: flat
    await seedCodex();
    // Codex commits in the three weeks with the most engaged time
    for (const i of [3, 4, 5]) {
      await sql.run(`INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, granularity, period_start, period_end, commit_count, computed_at)
        VALUES ('openai', 'organisation', ?, 'week', ?, ?, 2, ?)`, [ORG_SCOPE_ID, weeks[i], weeks[i] + 7 * DAY, NOW]);
    }
    expect((await (await get()).json()).observedLift.liftPct).toBeCloseTo(0, 6); // unchanged by Codex commits
  });

  it('names an unpriced Codex model and prices it to nothing, never $0-as-real', async () => {
    await seedCodex();
    await sql.exec(`UPDATE codex_turns SET model = 'no-such-model'`);
    const body = await (await get()).json();
    expect(body.split.codex.spend30d).toBeNull();
    expect(body.split.codex.unpricedModels).toEqual(['no-such-model']);
    expect(body.measured.spend30d).toBeCloseTo(2, 6);
  });

  it('leaves Codex out while ChatGPT and Codex are hidden', async () => {
    await seedCodex();
    await setConfigValue('openaiShown', 'false');
    const body = await (await get()).json();
    expect(body.split).toBeNull();
    expect(body.measured.spend30d).toBeCloseTo(2, 6);
    expect(body.measured.commitCount).toBe(4);
    expect(body.measured.activeUsers).toBe(1);
  });
});

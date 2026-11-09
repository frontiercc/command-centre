// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { weekStarts } from '@/lib/pulse/period';

let sql: TestSql;
let cleanup: () => Promise<void>;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let updateUseCase: typeof import('@/lib/usecases/queries').updateUseCase;
let buildGovernanceRollup: typeof import('@/lib/usecases/governance').buildGovernanceRollup;

const NOW = 1_720_000_000; // fixed; Math.random/Date.now not needed
const cal = { minutesPerSession: 30, loadedCompAnnual: 90000 };

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ createUseCase, updateUseCase } = await import('@/lib/usecases/queries'));
  ({ buildGovernanceRollup } = await import('@/lib/usecases/governance'));
});
afterAll(async () => cleanup());
beforeEach(async () => { await sql.exec(`DELETE FROM use_case_activation_weeks; DELETE FROM use_cases; DELETE FROM users;`); });

/** Write a measured week row directly. */
async function seedWeek(useCaseId: string, weekStart: number, users: number, sessions: number) {
  await sql.run(
    `INSERT INTO use_case_activation_weeks (use_case_id, week_start, distinct_users, session_count, matched_messages)
     VALUES (?, ?, ?, ?, ?)`,
    [useCaseId, weekStart, users, sessions, sessions],
  );
}

/** Write a measured week row carrying the Workflow Impact columns (migration adds these as nullable). */
async function seedImpactWeek(
  useCaseId: string,
  weekStart: number,
  opts: { sessions?: number; durationSecs?: number | null; toolErrors?: number | null; rejects?: number | null; flagged?: number | null } = {},
) {
  const sessions = opts.sessions ?? 1;
  await sql.run(
    `INSERT INTO use_case_activation_weeks
       (use_case_id, week_start, distinct_users, session_count, matched_messages,
        measured_duration_secs, tool_error_count, edit_reject_count, flagged_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      useCaseId, weekStart, 1, sessions, sessions,
      opts.durationSecs ?? null, opts.toolErrors ?? null, opts.rejects ?? null, opts.flagged ?? null,
    ],
  );
}

describe('governance rollup', () => {
  it('includes only strategic + confirmed bets', async () => {
    const bet = await createUseCase({ title: 'Contract review', status: 'confirmed' });
    await updateUseCase(bet.id, { strategic: 1 });
    await createUseCase({ title: 'Not strategic', status: 'confirmed' });            // strategic=0
    const strat = await createUseCase({ title: 'Strategic candidate', status: 'candidate' });
    await updateUseCase(strat.id, { strategic: 1 });                                 // strategic but not confirmed

    const rollup = await buildGovernanceRollup(NOW, cal);
    expect(rollup.headline.declared).toBe(1);
    expect(rollup.bets.map(b => b.title)).toEqual(['Contract review']);
  });

  it('young bet: absent weeks are null (not 0) and value sums measured weeks only', async () => {
    const bet = await createUseCase({ title: 'RFP drafting', status: 'confirmed' });
    await updateUseCase(bet.id, { strategic: 1 });
    const weeks = weekStarts(NOW - 7 * 86400, 13); // the 13 completed weeks, ascending
    // Only the last 3 completed weeks measured, 4 sessions each.
    await seedWeek(bet.id, weeks[10], 2, 4);
    await seedWeek(bet.id, weeks[11], 2, 4);
    await seedWeek(bet.id, weeks[12], 2, 4);

    const rollup = await buildGovernanceRollup(NOW, cal);
    const b = rollup.bets[0];
    expect(b.series.length).toBe(13);
    expect(b.series.slice(0, 10)).toEqual(Array(10).fill(null)); // absent → null
    expect(b.series.slice(10)).toEqual([4, 4, 4]);
    expect(b.measured.sessions).toBe(12);
    expect(b.estimated.hoursRecovered).toBe(6); // 12 * 30 / 60
    expect(rollup.value.hoursRecovered).toBe(6);
    expect(rollup.value.dollarsRecovered).toBe(300); // 6 * 50
    expect(rollup.value.isEstimate).toBe(true);
  });

  it('resolves owner display name from users, falls back to null when unset', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@b.co', 'Jane Doe')`);
    const bet = await createUseCase({ title: 'Owned bet', status: 'confirmed', ownerUserId: 'u1' });
    await updateUseCase(bet.id, { strategic: 1 });
    const rollup = await buildGovernanceRollup(NOW, cal);
    expect(rollup.bets[0].ownerDisplayName).toBe('Jane Doe');
  });

  it('measured.hours sums measured_duration_secs over the window into rounded hours, or null when unmeasured', async () => {
    const weeks = weekStarts(NOW - 7 * 86400, 13);

    const measuredBet = await createUseCase({ title: 'Measured bet', status: 'confirmed' });
    await updateUseCase(measuredBet.id, { strategic: 1 });
    await seedImpactWeek(measuredBet.id, weeks[10], { durationSecs: 3600 });
    await seedImpactWeek(measuredBet.id, weeks[11], { durationSecs: 5400 }); // 3600+5400=9000s = 2.5h

    const unmeasuredBet = await createUseCase({ title: 'Unmeasured bet', status: 'confirmed' });
    await updateUseCase(unmeasuredBet.id, { strategic: 1 });
    await seedWeek(unmeasuredBet.id, weeks[12], 1, 3); // session_count present, no impact columns

    const rollup = await buildGovernanceRollup(NOW, cal);
    const measured = rollup.bets.find(b => b.title === 'Measured bet')!;
    const unmeasured = rollup.bets.find(b => b.title === 'Unmeasured bet')!;
    expect(measured.measured.hours).toBe(2.5);
    expect(unmeasured.measured.hours).toBeNull();
  });

  it('allWorkflows lists only confirmed, non-strategic use cases, ranked by measuredHours desc with nulls last, friction summed across measured weeks', async () => {
    const weeks = weekStarts(NOW - 7 * 86400, 13);

    // Excluded from the map: a strategic bet (belongs to `bets`, not the map),
    // a non-confirmed candidate, and an archived one.
    const bet = await createUseCase({ title: 'Strategic bet', status: 'confirmed' });
    await updateUseCase(bet.id, { strategic: 1 });
    await createUseCase({ title: 'Candidate workflow', status: 'candidate' });
    await createUseCase({ title: 'Archived workflow', status: 'archived' });

    const high = await createUseCase({ title: 'High-hours workflow', status: 'confirmed' });
    await seedImpactWeek(high.id, weeks[11], { durationSecs: 7200, toolErrors: 2, rejects: 1 }); // 2h, friction 3
    await seedImpactWeek(high.id, weeks[12], { durationSecs: 3600, flagged: 1 });                // +1h, +1 friction -> 3h / friction 4
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'wu1', ''), (?, ?, 'wu2', '')`, [high.id, weeks[11], high.id, weeks[12]]);

    const low = await createUseCase({ title: 'Low-hours workflow', status: 'confirmed' });
    await seedImpactWeek(low.id, weeks[12], { durationSecs: 1800 }); // 0.5h

    const unmeasured = await createUseCase({ title: 'Unmeasured workflow', status: 'confirmed' });
    await seedWeek(unmeasured.id, weeks[12], 2, 5); // session_count present, no impact columns -> measuredHours null

    const rollup = await buildGovernanceRollup(NOW, cal);
    const titles = rollup.allWorkflows.map(w => w.title);
    expect(titles).not.toContain('Strategic bet');
    expect(titles).not.toContain('Candidate workflow');
    expect(titles).not.toContain('Archived workflow');
    expect(titles).toEqual(['High-hours workflow', 'Low-hours workflow', 'Unmeasured workflow']);

    const [highRow, lowRow, unmeasuredRow] = rollup.allWorkflows;
    expect(highRow.measuredHours).toBe(3);
    expect(highRow.distinctUsers).toBe(2);
    expect(highRow.series.length).toBe(13);
    expect(lowRow.measuredHours).toBe(0.5);
    expect(unmeasuredRow.measuredHours).toBeNull();

    // Under the 50-row cap, allWorkflowsTotal is just the returned count.
    expect(rollup.allWorkflowsTotal).toBe(rollup.allWorkflows.length);
    expect(rollup.allWorkflowsTotal).toBe(3);
  });
});

describe('governance rollup: sessions and hours by vendor', () => {
  async function seedSessions(useCaseId: string, week: number) {
    const match = (sid: string) => sql.run(
      `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'gu1', ?)`, [useCaseId, week, sid]);
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('gu1', 'gu1@example.com', 'GU1') ON CONFLICT DO NOTHING`);
    await match('gv-cw-1');
    await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES ('gv-cw-1', 'gv-cw-1', 'gu1') ON CONFLICT DO NOTHING`);
    await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, active_secs) VALUES ('gv-cw-1', 'gu1', 1, 3600) ON CONFLICT DO NOTHING`);
    await match('gv-cc-1');
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at, active_secs) VALUES ('gv-cc-1', 1, 2, 1, 1800) ON CONFLICT DO NOTHING`);
    await match('chatgpt:gv-a');
    await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, computed_at, active_secs) VALUES ('chatgpt:gv-a', 'gu1', 'chatgpt_work', 1, 2, 1, 7200) ON CONFLICT DO NOTHING`);
    await match('codex:gv-b');
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at, active_secs) VALUES ('codex:gv-b', 1, 2, 1, 3600) ON CONFLICT DO NOTHING`);
    await match('chatgpt:gv-nostats'); // no session row: not counted, as on the use case page
  }
  async function clearSessions() {
    await sql.exec(`DELETE FROM use_case_week_matches;
      DELETE FROM cowork_session_stats WHERE session_id = 'gv-cw-1';
      DELETE FROM cowork_sessions WHERE id = 'gv-cw-1';
      DELETE FROM code_session_stats WHERE session_id IN ('gv-cc-1', 'codex:gv-b', 'gv-cc-nul');
      DELETE FROM chatgpt_session_time WHERE session_id = 'chatgpt:gv-a';`);
  }

  it('splits each bet and each other use case by vendor over the 13-week window', async () => {
    const weeks = weekStarts(NOW - 7 * 86400, 13);
    const bet = await createUseCase({ title: 'Vendor bet', status: 'confirmed' });
    await updateUseCase(bet.id, { strategic: 1 });
    await seedImpactWeek(bet.id, weeks[12], { sessions: 4, durationSecs: 16200 });
    await seedSessions(bet.id, weeks[12]);
    const wf = await createUseCase({ title: 'Vendor workflow', status: 'confirmed' });
    await seedSessions(wf.id, weeks[11]);
    // Outside the window: never counted
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'gu1', 'gv-cw-1')`, [wf.id, weeks[0] - 7 * 86400]);
    const quiet = await createUseCase({ title: 'Quiet workflow', status: 'confirmed' });

    try {
      const rollup = await buildGovernanceRollup(NOW, cal, { openaiShown: true });
      const b = rollup.bets[0];
      expect(b.measured.platformSessions).toEqual({ claude: 2, openai: 2 });
      expect(b.measured.platformHours).toEqual({ claude: 1.5, openai: 3 });
      expect(b.measured.hours).toBe(4.5); // existing field unchanged
      const w = rollup.allWorkflows.find(x => x.title === 'Vendor workflow')!;
      expect(w.platformSessions).toEqual({ claude: 2, openai: 2 });
      const q = rollup.allWorkflows.find(x => x.title === 'Quiet workflow')!;
      expect(q.platformSessions).toEqual({ claude: 0, openai: 0 });
      expect(quiet.id).toBeTruthy();
    } finally {
      await clearSessions();
    }
  });

  it('leaves OpenAI out while ChatGPT and Codex are hidden, and reads unmeasured time as null', async () => {
    const weeks = weekStarts(NOW - 7 * 86400, 13);
    const bet = await createUseCase({ title: 'Hidden bet', status: 'confirmed' });
    await updateUseCase(bet.id, { strategic: 1 });
    await seedSessions(bet.id, weeks[12]);
    const nul = await createUseCase({ title: 'Null-time bet', status: 'confirmed' });
    await updateUseCase(nul.id, { strategic: 1 });
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'gu1', 'gv-cc-nul')`, [nul.id, weeks[12]]);
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at) VALUES ('gv-cc-nul', 1, 2, 1)`);

    try {
      const rollup = await buildGovernanceRollup(NOW, cal, { openaiShown: false });
      const hidden = rollup.bets.find(b => b.title === 'Hidden bet')!;
      expect(hidden.measured.platformSessions).toEqual({ claude: 2, openai: null });
      expect(hidden.measured.platformHours).toEqual({ claude: 1.5, openai: null });
      const n = rollup.bets.find(b => b.title === 'Null-time bet')!;
      expect(n.measured.platformSessions).toEqual({ claude: 1, openai: null });
      expect(n.measured.platformHours).toEqual({ claude: null, openai: null });
    } finally {
      await clearSessions();
    }
  });

  it('counts each session in the hours only in the earliest week it matched', async () => {
    const { getUseCasePlatformHours } = await import('@/lib/usecases/platform-sessions');
    const weeks = weekStarts(NOW - 7 * 86400, 13);
    const uc = await createUseCase({ title: 'Earliest-week workflow', status: 'confirmed' });
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('gu1', 'gu1@example.com', 'GU1') ON CONFLICT DO NOTHING`);
    const match = (sid: string, week: number) => sql.run(
      `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'gu1', ?)`, [uc.id, week, sid]);
    // First matched before the window, matched again inside it: left out.
    await match('gv-early', weeks[0] - 7 * 86400);
    await match('gv-early', weeks[6]);
    await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES ('gv-early', 'gv-early', 'gu1')`);
    await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, active_secs) VALUES ('gv-early', 'gu1', 1, 7200)`);
    // First matched inside the window, matched again later in it: counted once.
    await match('gv-inside', weeks[3]);
    await match('gv-inside', weeks[9]);
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at, active_secs) VALUES ('gv-inside', 1, 2, 1, 1800)`);

    try {
      const hours = await getUseCasePlatformHours(NOW, { openaiShown: true });
      expect(hours.get(uc.id)).toEqual({ claude: 0.5, openai: null });
    } finally {
      await sql.exec(`DELETE FROM use_case_week_matches;
        DELETE FROM cowork_session_stats WHERE session_id = 'gv-early';
        DELETE FROM cowork_sessions WHERE id = 'gv-early';
        DELETE FROM code_session_stats WHERE session_id = 'gv-inside';`);
    }
  });

  it('a use case whose only session was first matched before the window has no hours', async () => {
    const { getUseCasePlatformHours } = await import('@/lib/usecases/platform-sessions');
    const weeks = weekStarts(NOW - 7 * 86400, 13);
    const uc = await createUseCase({ title: 'Old-session workflow', status: 'confirmed' });
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES ('gu1', 'gu1@example.com', 'GU1') ON CONFLICT DO NOTHING`);
    const match = (week: number) => sql.run(
      `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'gu1', 'gv-old')`, [uc.id, week]);
    await match(weeks[0] - 14 * 86400);
    await match(weeks[12]);
    await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at, active_secs) VALUES ('gv-old', 1, 2, 1, 3600)`);

    try {
      const hours = await getUseCasePlatformHours(NOW, { openaiShown: true });
      expect(hours.has(uc.id)).toBe(false);
    } finally {
      await sql.exec(`DELETE FROM use_case_week_matches;
        DELETE FROM code_session_stats WHERE session_id = 'gv-old';`);
    }
  });
});

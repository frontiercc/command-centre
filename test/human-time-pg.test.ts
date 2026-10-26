// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Human time vs Claude time on Postgres, model mocked:
// the Code classifier stores an estimate for tier 2/3 only and writes nothing
// new with the switch off; the Cowork estimate job sizes Tier 2/3 sessions from
// scrubbed prompts, framed by department, capped at 3 attempts; the totals
// count only sessions carrying both figures.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

const sent: Array<{ system?: string; content: string }> = [];
let nextReply = '[]';
vi.mock('@/lib/anthropic/client', () => ({
  createAnthropicClient: () => ({
    messages: {
      create: async (req: { system?: string; messages: Array<{ content: string }> }) => {
        sent.push({ system: req.system, content: req.messages[0].content });
        return { content: [{ type: 'text', text: nextReply }] };
      },
    },
  }),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function codeSession(id: string, at: number) {
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, computed_at, active_secs)
    VALUES (?, 'u1', ?, ?, 3, 20, 60, ?, 1800)`, [id, at - 3600, at, at]);
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
    VALUES (?, ?, 'u1', 'code_user_message', 'code', 'Add the export button', ?), (?, ?, 'u1', 'code_user_message', 'code', 'Now email jane.doe@example.com', ?)`,
    [`${id}-p1`, id, at - 3500, `${id}-p2`, id, at - 3000]);
  await sql.run(`INSERT INTO code_otel_metrics (id, session_id, user_id, metric_name, value, type, occurred_at)
    VALUES (?, ?, 'u1', 'claude_code.lines_of_code.count', 120, 'added', ?)`, [`${id}-m`, id, at]);
}

async function coworkPrompt(id: string, session: string, text: string, tier: number, at: number) {
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, content_full, occurred_at)
    VALUES (?, ?, 'u1', 'cowork_user_message', 'cowork', ?, ?, ?)`, [id, session, text.slice(0, 50), text, at]);
  await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
    VALUES (?, 'u1', ?, 'analysis', 0.9, 'haiku', ?)`, [id, tier, at]);
}

async function coworkSession(id: string, at: number) {
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES (?, ?, 'u1')`, [id, id]);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, computed_at, active_secs)
    VALUES (?, 'u1', ?, ?, ?, 900)`, [id, at - 1800, at, at]);
}

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  await seedUserSql(sql, 'u1');
  await sql.run(`UPDATE users SET department = 'Finance' WHERE id = 'u1'`);
  const { setConfigValue } = await import('@/lib/config');
  await setConfigValue('anthropicAiApiKey', 'test-key');
});
afterAll(async () => cleanup());

describe('Code classifier with the switch off', () => {
  it('sends the old prompt and writes no estimate', async () => {
    await codeSession('c-off', NOW - 2 * DAY);
    nextReply = JSON.stringify([{ session_id: 'c-off', work_type: 'feature', tier: 2, confidence: 0.9, human_minutes: { low: 60, likely: 120, high: 240 } }]);
    sent.length = 0;
    const { runCodeClassifierJob } = await import('@/lib/pulse/code/classifier');
    await runCodeClassifierJob();
    expect(sent[0].system).not.toContain('human_minutes');
    expect(sent[0].content).not.toContain('lines_added');
    const row = await sql.get<{ likely: number | null }>(`SELECT human_minutes_likely AS likely FROM code_session_classifications WHERE session_id = 'c-off'`);
    expect(row?.likely).toBeNull();
  });
});

describe('Code classifier with the switch on', () => {
  it('stores an estimate for tier 2/3, none for tier 1, from masked evidence', async () => {
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('humanTimeEnabled', 'true');
    await codeSession('c-t2', NOW - 2 * DAY);
    await codeSession('c-t1', NOW - 2 * DAY);
    nextReply = JSON.stringify([
      { session_id: 'c-t2', work_type: 'feature', tier: 2, confidence: 0.9, human_minutes: { low: 60, likely: 120, high: 240 } },
      { session_id: 'c-t1', work_type: 'other', tier: 1, confidence: 0.9, human_minutes: { low: 5, likely: 10, high: 20 } },
    ]);
    sent.length = 0;
    const { runCodeClassifierJob } = await import('@/lib/pulse/code/classifier');
    await runCodeClassifierJob();
    expect(sent[0].system).toContain('human_minutes');
    expect(sent[0].content).toContain('lines_added: 120');
    expect(sent[0].content).toContain('later_prompts:');
    expect(sent[0].content).not.toContain('jane.doe@example.com');
    const rows = await sql.all<{ id: string; low: number | null; likely: number | null; high: number | null }>(
      `SELECT session_id AS id, human_minutes_low AS low, human_minutes_likely AS likely, human_minutes_high AS high
       FROM code_session_classifications WHERE session_id IN ('c-t2','c-t1') ORDER BY session_id`);
    expect(rows).toEqual([
      { id: 'c-t1', low: null, likely: null, high: null },
      { id: 'c-t2', low: 60, likely: 120, high: 240 },
    ]);
  });
});

describe('Cowork estimate job', () => {
  it('sizes Tier 2/3 sessions only, from scrubbed prompts framed by department', async () => {
    await coworkSession('w-t2', NOW - DAY);
    await coworkPrompt('wm1', 'w-t2', 'Build the Q3 variance pack and email jane.doe@example.com', 2, NOW - DAY);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, tool_name, output_name, occurred_at)
      VALUES ('wo1', 'w-t2', 'u1', 'cowork_tool_metadata', 'cowork', 'Write', 'Write', 'Q3_variance_pack.xlsx', ?)`, [NOW - DAY + 60]);
    await coworkSession('w-t1', NOW - DAY);
    await coworkPrompt('wm2', 'w-t1', 'Fix the typo', 1, NOW - DAY);
    const prompts: string[] = [];
    const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
    const r = await runSessionEstimateJob(NOW, { callModel: async (p) => { prompts.push(p); return { text: '{"low": 90, "likely": 180, "high": 300}' }; } });
    expect(r).toEqual({ written: 1, refused: 0, skipped: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('someone in Finance');
    expect(prompts[0]).toContain('Build the Q3 variance pack'); // what was asked
    expect(prompts[0]).toContain('Outputs produced: Q3_variance_pack.xlsx'); // and what came out
    expect(prompts[0]).not.toContain('jane.doe@example.com');
    const rows = await sql.all<{ id: string; likely: number | null }>(
      `SELECT session_id AS id, human_minutes_likely AS likely FROM cowork_session_stats WHERE session_id IN ('w-t1','w-t2') ORDER BY session_id`);
    expect(rows).toEqual([{ id: 'w-t1', likely: null }, { id: 'w-t2', likely: 180 }]);
  });

  it('repairs once, then counts an attempt, and stops after three', async () => {
    await coworkSession('w-bad', NOW - DAY);
    await coworkPrompt('wm3', 'w-bad', 'Draft the board summary', 3, NOW - DAY);
    const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
    let calls = 0;
    const bad = async () => { calls++; return { text: 'about an hour' }; };
    for (let i = 0; i < 4; i++) await runSessionEstimateJob(NOW, { callModel: bad });
    expect(calls).toBe(6); // 2 calls a run, 3 runs, then left alone
    const row = await sql.get<{ a: number; likely: number | null }>(
      `SELECT human_minutes_attempts AS a, human_minutes_likely AS likely FROM cowork_session_stats WHERE session_id = 'w-bad'`);
    expect(row).toEqual({ a: 3, likely: null });
  });

  it('a model-call error stops the run and counts nothing', async () => {
    await coworkSession('w-err', NOW - DAY);
    await coworkPrompt('wm4', 'w-err', 'Summarise the tender pack', 2, NOW - DAY);
    const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
    const r = await runSessionEstimateJob(NOW, { callModel: async () => { throw new Error('rate limited'); } });
    expect(r.apiError).toBe('rate limited');
    const row = await sql.get<{ a: number }>(`SELECT human_minutes_attempts AS a FROM cowork_session_stats WHERE session_id = 'w-err'`);
    expect(row?.a).toBe(0);
  });

  it('does nothing with the switch off', async () => {
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('humanTimeEnabled', 'false');
    const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
    expect(await runSessionEstimateJob(NOW, { callModel: async () => ({ text: '{}' }) })).toEqual({ written: 0, refused: 0, skipped: true });
    await setConfigValue('humanTimeEnabled', 'true');
  });
});

describe('buildHumanTimeSummary', () => {
  it('counts only sessions with both figures, per surface and scope', async () => {
    const { buildHumanTimeSummary } = await import('@/lib/pulse/human-time-summary');
    const code = await buildHumanTimeSummary({ surface: 'code', nowS: NOW, minSessionsForRatio: 1 });
    expect(code.sessions).toBe(1);
    expect(code.humanMinutes.likely).toBe(120);
    expect(code.claudeMinutes).toBe(30);
    expect(code.ratio).toBe(4);
    const cowork = await buildHumanTimeSummary({ surface: 'cowork', nowS: NOW, minSessionsForRatio: 20 });
    expect(cowork.sessions).toBe(1);
    expect(cowork.humanMinutes.likely).toBe(180);
    expect(cowork.ratio).toBeNull();
    const nobody = await buildHumanTimeSummary({ surface: 'cowork', nowS: NOW, userIds: [], minSessionsForRatio: 1 });
    expect(nobody.sessions).toBe(0);
    const other = await buildHumanTimeSummary({ surface: 'code', nowS: NOW, userIds: ['someone-else'], minSessionsForRatio: 1 });
    expect(other.sessions).toBe(0);
  });
});

describe('org outputs (digest, connector)', () => {
  it('readOrgHumanTime honours a fixed window and adds both surfaces', async () => {
    const { readOrgHumanTime } = await import('@/lib/pulse/human-time-summary');
    const h = await readOrgHumanTime(NOW - 7 * DAY, NOW + DAY);
    expect(h?.total).toEqual({ sessions: 2, humanMinutes: 300, claudeMinutes: 45 });
    expect(await readOrgHumanTime(NOW - 60 * DAY, NOW - 40 * DAY)).toBeNull();
  });
  it('the connector summary carries org totals only, no person or session id', async () => {
    const { getConnectorSummary } = await import('@/lib/connector/data');
    // The digest reads the last COMPLETED week, so run it a week on.
    const out = JSON.stringify(await getConnectorSummary(NOW + 7 * DAY));
    expect(out).not.toContain('u1');
    expect(out).not.toContain('w-t2');
    expect(out).not.toContain('c-t2');
  });
});

describe('Code backfill (runs last: it changes the counts above)', () => {
  it('estimates classified Tier 2/3 sessions, writes only the estimate, tries each once', async () => {
    const { estimateClassifiedCodeSessions } = await import('@/lib/pulse/code/classifier');
    const before = await sql.get<{ tier: number; work_type: string; at: number }>(
      `SELECT tier, work_type, classified_at AS at FROM code_session_classifications WHERE session_id = 'c-off'`);
    const systems: string[] = [];
    const r = await estimateClassifiedCodeSessions(new Set(), {
      callModel: async (system, user) => {
        systems.push(system);
        expect(user).toContain('session_id: c-off');
        return JSON.stringify([{ session_id: 'c-off', human_minutes: { low: 30, likely: 90, high: 180 } }]);
      },
    });
    expect(r).toEqual({ attempted: ['c-off'], written: 1 });
    expect(systems[0]).not.toContain('work_type');
    const after = await sql.get<{ tier: number; work_type: string; at: number; likely: number }>(
      `SELECT tier, work_type, classified_at AS at, human_minutes_likely AS likely FROM code_session_classifications WHERE session_id = 'c-off'`);
    expect(after).toEqual({ ...before, likely: 90 });
    // Nothing left; and a skipped id is never re-sent.
    expect(await estimateClassifiedCodeSessions(new Set(['c-off']), { callModel: async () => '[]' })).toEqual({ attempted: [], written: 0 });
  });
});

describe('spot-check', () => {
  it('draws the same sample twice, records verdicts and reports counts only', async () => {
    const { drawChecks, listChecks, recordCheck, latestCheckResult } = await import('@/lib/pulse/human-time-checks');
    expect(await latestCheckResult('cowork')).toBeNull();
    expect(await drawChecks('cowork', '2026-09', NOW)).toBe(1);
    expect(await drawChecks('cowork', '2026-09', NOW)).toBe(1); // idempotent
    const items = await listChecks('cowork', '2026-09');
    expect(items[0]).toMatchObject({ sessionId: 'w-t2', estimate: { low: 90, likely: 180, high: 300 }, claudeMinutes: 15, verdict: null });
    expect(await recordCheck(items[0].id, 'too_high', 120)).toBe(true);
    expect(await latestCheckResult('cowork')).toEqual({ period: '2026-09', reviewed: 1, aboutRight: 0 });
    expect(await recordCheck(999999, 'about_right', null)).toBe(false);
  });
});

describe('zero active time', () => {
  it('a session with 0 measured seconds is not counted', async () => {
    await coworkSession('w-zero', NOW - DAY);
    await sql.run(`UPDATE cowork_session_stats SET active_secs = 0, human_minutes_low = 60, human_minutes_likely = 120, human_minutes_high = 240 WHERE session_id = 'w-zero'`);
    const { buildHumanTimeSummary } = await import('@/lib/pulse/human-time-summary');
    const s = await buildHumanTimeSummary({ surface: 'cowork', nowS: NOW, userIds: ['u1'], minSessionsForRatio: 1 });
    expect(s.humanMinutes.likely).toBe(180); // w-t2 only
  });
});

describe('Code backlog pass', () => {
  it('counts every try, gives up after three, and honours the window', async () => {
    await codeSession('c-stubborn', NOW - 2 * DAY);
    await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, classified_at)
      VALUES ('c-stubborn', 'u1', 'feature', 2, 0.9, 'haiku', ?)`, [NOW]);
    const { estimateClassifiedCodeSessions } = await import('@/lib/pulse/code/classifier');
    // Outside the window: not selected.
    expect((await estimateClassifiedCodeSessions(new Set(), { callModel: async () => '[]' }, { sinceS: NOW - DAY })).attempted).toEqual([]);
    for (let i = 0; i < 4; i++) await estimateClassifiedCodeSessions(new Set(), { callModel: async () => 'no json here' }, { sinceS: NOW - 7 * DAY });
    const row = await sql.get<{ a: number; likely: number | null }>(
      `SELECT human_minutes_attempts AS a, human_minutes_likely AS likely FROM code_session_classifications WHERE session_id = 'c-stubborn'`);
    expect(row).toEqual({ a: 3, likely: null });
  });
});

describe('separate switches (runs last)', () => {
  it('Code off with Cowork on hides Code only; Code on with Cowork off shows Code only', async () => {
    const { setConfigValue } = await import('@/lib/config');
    const { readHumanTime, readOrgHumanTime } = await import('@/lib/pulse/human-time-summary');
    await setConfigValue('humanTimeEnabled', 'true');
    await setConfigValue('humanTimeCodeEnabled', 'false');
    expect(await readHumanTime('code')).toBeNull();
    expect(await readHumanTime('cowork')).not.toBeNull();
    const coworkOnly = await readOrgHumanTime(NOW - 7 * DAY, NOW + DAY);
    expect(coworkOnly?.code.sessions).toBe(0);
    expect(coworkOnly?.cowork.sessions).toBeGreaterThan(0);

    await setConfigValue('humanTimeEnabled', 'false');
    await setConfigValue('humanTimeCodeEnabled', 'true');
    expect(await readHumanTime('cowork')).toBeNull();
    expect(await readHumanTime('code')).not.toBeNull();
    const codeOnly = await readOrgHumanTime(NOW - 7 * DAY, NOW + DAY);
    expect(codeOnly?.cowork.sessions).toBe(0);
    expect(codeOnly?.code.sessions).toBeGreaterThan(0);
    const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
    expect((await runSessionEstimateJob(NOW, { callModel: async () => ({ text: '{}' }) })).skipped).toBe(true);

    await setConfigValue('humanTimeCodeEnabled', 'false');
    expect(await readOrgHumanTime(NOW - 7 * DAY, NOW + DAY)).toBeNull();
  });
});

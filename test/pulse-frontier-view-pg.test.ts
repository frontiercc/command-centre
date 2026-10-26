// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// buildFrontierView end to end on Postgres: best work with
// its measured facts, a matched use case, peers at the same depth, the person's
// mainstay deep work, a capability card with no prompt text, and NULL
// (unmeasured) facts staying null.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000);
const DAY = 86400;

async function session(id: string, userId: string, at: number) {
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, started_at) VALUES (?, ?, ?, ?)`, [id, id, userId, at]);
}
let msgN = 0;
async function classified(sessionId: string, userId: string, taskType: string, tier: number, at: number, capability = 0) {
  const id = `m${++msgN}`;
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
     VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'SECRET PROMPT TEXT', ?)`, [id, sessionId, userId, at]);
  await sql.run(
    `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, capability_creation_candidate, classifier_confidence, classifier_model, classified_at)
     VALUES (?, ?, ?, ?, ?, 0.9, 'haiku', ?)`, [id, userId, tier, taskType, capability, at]);
  return id;
}

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  for (const u of ['gia', 'ben', 'cat']) await seedUserSql(sql, u);
  await sql.run(`UPDATE users SET department = 'Sales', display_name = 'Marco' WHERE id = 'gia'`);
  await sql.run(`UPDATE users SET department = 'Sales', display_name = 'Ben' WHERE id = 'ben'`);
  await sql.run(`UPDATE users SET department = 'Legal', display_name = 'Cat' WHERE id = 'cat'`);

  // Marco: analysis at Tier 1–2 three times over six weeks, then Tier 3 two days ago.
  for (const [i, at] of [[1, NOW - 50 * DAY], [2, NOW - 40 * DAY], [3, NOW - 20 * DAY]] as const) {
    await session(`g${i}`, 'gia', at);
    await classified(`g${i}`, 'gia', 'analysis', i === 1 ? 1 : 2, at);
  }
  await session('g4', 'gia', NOW - 2 * DAY);
  await classified('g4', 'gia', 'analysis', 3, NOW - 2 * DAY);
  await classified('g4', 'gia', 'connector_orchestration', 3, NOW - 2 * DAY);
  const capMsg = await classified('g4', 'gia', 'capability_creation', 3, NOW - 2 * DAY, 1);
  await sql.run(
    `INSERT INTO cowork_session_stats (session_id, user_id, tool_call_count, active_secs, upload_count, produced_output, computed_at)
     VALUES ('g4', 'gia', 31, 2520, 2, 1, ?)`, [NOW]);
  await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at) VALUES ('i1','gia','g4','salesforce','query',?), ('i2','gia','g4','workspace','x',?)`, [NOW - 2 * DAY, NOW - 2 * DAY]);
  await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at) VALUES ('k1','gia','g4','anthropic-skills:xlsx',?)`, [NOW - 2 * DAY]);
  // How the work was done, what came out, what went in, and a description.
  for (const [id, tool, ok, name] of [
    ['t1', 'WebSearch', 1, null], ['t2', 'WebSearch', 1, null], ['t3', 'Read', 1, null],
    ['t4', 'Write', 1, 'Q3-variance.xlsx'], ['t5', 'Write', 0, null], ['t6', 'Artifact', 1, null],
  ] as const) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, tool_success, output_name, occurred_at)
      VALUES (?, 'g4', 'gia', 'cowork_tool_metadata', 'cowork', ?, ?, ?, ?)`, [id, tool, ok, name, NOW - 2 * DAY]);
  }
  await sql.run(`UPDATE cowork_sessions SET files_uploaded = ? WHERE id = 'g4'`, [JSON.stringify(['/u/forecast.xlsx', '/u/actuals.csv', '/u/brief.pdf'])]);
  await sql.run(`INSERT INTO cowork_session_descriptions (session_id, user_id, description, attempts, occurred_at, generated_at)
    VALUES ('g4', 'gia', 'Compared pipeline actuals with the forecast for leadership.', 1, ?, ?)`, [NOW - 2 * DAY, NOW]);
  await sql.run(`INSERT INTO use_cases (id, title, status) VALUES ('uc1', 'Weekly pipeline review', 'confirmed'), ('uc2', 'Draft only', 'candidate')`);
  await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES ('uc1', ?, 'gia', 'g4'), ('uc2', ?, 'gia', 'g4')`, [NOW - 7 * DAY, NOW - 7 * DAY]);
  await sql.run(
    `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
     VALUES ('gia', 'capability_creation', 'candidate', 'New capability', 'Prompt: "SECRET PROMPT TEXT"', ?, 3, ?)`, [capMsg, NOW - 2 * DAY]);

  // Ben (same department) does analysis at Tier 3 too; his session has no stats row at all.
  await session('b1', 'ben', NOW - 3 * DAY);
  await classified('b1', 'ben', 'analysis', 3, NOW - 3 * DAY);
  // Cat (another department) does analysis at Tier 3 — must not count as a Sales peer.
  await session('c1', 'cat', NOW - 3 * DAY);
  await classified('c1', 'cat', 'analysis', 3, NOW - 3 * DAY);
});
afterAll(async () => cleanup());

describe('buildFrontierView (postgres)', () => {
  it('person: best work carries measured facts, the matched use case and peers', async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const v = await buildFrontierView({ userId: 'gia' }, NOW);
    expect(v.bestWork).toHaveLength(1);
    const b = v.bestWork[0];
    expect(b).toMatchObject({ sessionId: 'g4', taskType: 'analysis', tier: 3, department: 'Sales', othersAtDepth: 1 });
    expect(b.facts).toMatchObject({ activeSecs: 2520, steps: 31, uploads: 2, producedOutput: true, connectors: ['salesforce'], skills: ['anthropic-skills:xlsx'] });
    expect(b.facts.how).toEqual({ searches: 2, fetches: 0, reads: 1, planned: 0, questions: 0 });
    expect(b.facts.outputs).toEqual({ written: 1, sent: 0, artifacts: 1 }); // the failed Write does not count
    expect(b.facts.inputs).toEqual(['2 spreadsheets', 'a PDF']);
    // Default viewer: not an admin/manager and not Marco — detail withheld.
    expect(b.detailWithheld).toBe(true);
    expect(b.description).toBeNull();
    expect(b.facts.outputNames).toEqual([]);
    expect(b.useCase).toEqual({ id: 'uc1', title: 'Weekly pipeline review' });
  });

  it('person: mainstay deep work is the named Tier 3 kind, as a share', async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const v = await buildFrontierView({ userId: 'gia' }, NOW);
    expect(v.mainstay).toMatchObject({ count: 1, tier3Sessions: 1, item: { kind: 'mainstay', sessionId: 'g4', taskType: 'analysis' } });
    const dept = await buildFrontierView({ dept: 'Sales' }, NOW);
    expect(dept.mainstay).toBeNull(); // person page only
  });

  it("detail: Marco sees his own, an admin/manager sees everyone's, another person sees neither", async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const own = (await buildFrontierView({ userId: 'gia' }, NOW, { seeAllDetail: false, ownUserId: 'gia' })).bestWork[0];
    expect(own.description).toBe('Compared pipeline actuals with the forecast for leadership.');
    expect(own.facts.outputNames).toEqual(['Q3-variance.xlsx']);
    const mgr = await buildFrontierView({ dept: 'Sales' }, NOW, { seeAllDetail: true, ownUserId: null });
    expect(mgr.bestWork[0].description).not.toBeNull();
    const ben = await buildFrontierView({ dept: 'Sales' }, NOW, { seeAllDetail: false, ownUserId: 'ben' });
    const giaSeenByBen = ben.bestWork.find(w => w.userId === 'gia')!;
    expect(giaSeenByBen.description).toBeNull();
    expect(giaSeenByBen.facts.outputNames).toEqual([]);
    expect(JSON.stringify(ben)).not.toContain('Q3-variance.xlsx');
    expect(ben.bestWork.find(w => w.userId === 'ben')!.detailWithheld).toBe(false);
  });

  it('capability card: status and pending count, never the prompt text', async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const v = await buildFrontierView({ userId: 'gia' }, NOW);
    expect(v.capabilities).toHaveLength(1);
    expect(v.capabilities[0].capability?.status).toBe('candidate');
    expect(v.capabilityPending).toBe(1);
    expect(JSON.stringify(v)).not.toContain('SECRET PROMPT TEXT');
  });

  it('department: counts Tier 3 people, one best-work row per person, unmeasured facts stay null', async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const v = await buildFrontierView({ dept: 'Sales' }, NOW);
    expect(v.tier3People).toBe(2);
    expect(v.bestWork.map(b => b.displayName)).toEqual(['Marco', 'Ben']);
    const ben = v.bestWork[1];
    expect(ben.facts).toMatchObject({ activeSecs: null, steps: null, uploads: null, producedOutput: null, connectors: [], skills: [], outputNames: [], inputs: [] });
    expect(ben.othersAtDepth).toBe(1); // Marco, not Cat
    expect(v.feed.map(f => f.kind)).toEqual(['capability']);
  });

  it('an unknown department is empty, not an error', async () => {
    const { buildFrontierView } = await import('@/lib/pulse/frontier-view');
    const v = await buildFrontierView({ dept: 'Nowhere' }, NOW);
    expect(v).toMatchObject({ bestWork: [], mainstay: null, capabilities: [], feed: [], tier3People: 0 });
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spread on Postgres now that use cases are defined by the work: people whose sessions were
// judged to be the use case's work, who have never run its skill.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let spread: typeof import('@/lib/usecases/spread');
let weekStart: typeof import('@/lib/pulse/period').weekStart;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ createUseCase } = await import('@/lib/usecases/queries'));
  spread = await import('@/lib/usecases/spread');
  ({ weekStart } = await import('@/lib/pulse/period'));
});
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_week_matches; DELETE FROM use_case_skill_drafts; DELETE FROM use_cases;
    DELETE FROM cowork_skill_invocations; DELETE FROM users; DELETE FROM coaching_acks; DELETE FROM config;`);
  await sql.run(`INSERT INTO config (key, value, updated_at) VALUES ('use_cases_enabled', 'true', ?)`, [NOW]);
});

async function user(id: string, dept: string | null, deactivated = false) {
  await sql.run(`INSERT INTO users (id, email, display_name, department, deactivated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `${id}@t.local`, id.toUpperCase(), dept, deactivated ? NOW : null]);
}
async function withSkill(ucId: string, name: string, downloaded = true) {
  await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, model, generated_at, downloaded_at)
    VALUES (?, ?, 'd', 'b', '[]', '{}', '{}', 'm', ?, ?)`, [ucId, name, NOW, downloaded ? NOW : null]);
}
/** n judged sessions of the use case's work, in the last completed week. */
async function judgedSessions(ucId: string, userId: string, n: number, weeksAgo = 1) {
  const wk = weekStart(NOW) - weeksAgo * 7 * DAY;
  for (let i = 0; i < n; i++) {
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, ?, ?)`, [ucId, wk, userId, `${userId}-${ucId}-${weeksAgo}-${i}`]);
  }
}
async function ranSkill(userId: string, name: string) {
  await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at) VALUES (?, ?, ?, ?, ?)`, [`inv-${userId}-${name}`, userId, `sk-${userId}`, name, NOW - 30 * DAY]);
}
async function finance() {
  return createUseCase({ title: 'Month-end variance commentary', description: 'Finance work.', departments: ['Finance'], status: 'confirmed' });
}

describe('findSpreadCandidates', () => {
  it('a use case with no downloaded skill has nothing to spread', async () => {
    const uc = await finance();
    expect(await spread.findSpreadCandidates(uc, NOW)).toEqual({ unsupported: 'no_skill' });
    await withSkill(uc.id, 'variance-commentary', false);
    expect(await spread.findSpreadCandidates(uc, NOW)).toEqual({ unsupported: 'no_skill' });
  });

  it('lists people doing the work regularly who never ran the skill; skill users count as adopters', async () => {
    await user('anna', 'Finance'); await user('ben', 'Finance'); await user('cara', 'Finance'); await user('dan', 'Finance', true);
    const uc = await finance();
    await withSkill(uc.id, 'variance-commentary');
    await judgedSessions(uc.id, 'anna', 3);
    await judgedSessions(uc.id, 'ben', 1);              // below the bar
    await judgedSessions(uc.id, 'cara', 4);
    await ranSkill('cara', 'acme-library:variance-commentary'); // ran it under a marketplace prefix
    await judgedSessions(uc.id, 'dan', 5);              // deactivated
    await judgedSessions(uc.id, 'anna', 6, 0);          // the current week is not counted

    const res = await spread.findSpreadCandidates(uc, NOW);
    if (!res || 'unsupported' in res) throw new Error('expected departments');
    expect(res.departments).toHaveLength(1);
    expect(res.departments[0].users.map(u => [u.userId, u.activityCount])).toEqual([['anna', 3]]);
    expect(res.departments[0].adopterCount).toBe(1);
  });

  it('an acknowledged pair vanishes from the panel, the department prompts and the digest counts', async () => {
    await user('anna', 'Finance'); await user('eve', 'Finance');
    const uc = await finance();
    await withSkill(uc.id, 'variance-commentary');
    await judgedSessions(uc.id, 'anna', 3);
    await judgedSessions(uc.id, 'eve', 3);
    await spread.acknowledgeCoachingPrompt('anna', uc.id, 'admin@test.local');

    const res = await spread.findSpreadCandidates(uc, NOW);
    if (!res || 'unsupported' in res) throw new Error('expected departments');
    expect(res.departments[0].users.map(u => u.userId)).toEqual(['eve']);
    const prompts = await spread.getDeptCoachingPrompts('Finance', NOW);
    expect(prompts.map(p => p.userId)).toEqual(['eve']);
    expect(prompts[0].promptText).toContain('variance-commentary');
    expect(await spread.getCoachingCountsByDept(NOW)).toEqual([{ dept: 'Finance', count: 1 }]);

    await spread.unacknowledgeCoachingPrompt('anna', uc.id);
    expect((await spread.getCoachingCountsByDept(NOW))[0].count).toBe(2);
  });

  it('candidates and archived use cases produce no coaching; counts carry no names', async () => {
    await user('anna', 'Finance');
    const cand = await createUseCase({ title: 'Candidate', departments: ['Finance'], status: 'candidate' });
    await withSkill(cand.id, 'cand-skill');
    await judgedSessions(cand.id, 'anna', 3);
    expect(await spread.getCoachingCountsByDept(NOW)).toEqual([]);
    expect(JSON.stringify(await spread.getCoachingCountsByDept(NOW))).not.toContain('ANNA');
  });
});

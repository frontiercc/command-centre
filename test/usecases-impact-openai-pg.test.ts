// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Workflow Impact with ChatGPT and Codex sessions: counted and timed under
// their own product (never as Claude Cowork or Claude Code), and their models
// in the Models column (Codex from its turns, ChatGPT from its replies).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const WEEK = 7 * 86400;
const WK = 1755475200; // a Monday 00:00 UTC
const NOW = WK + 13 * WEEK + 100;
const UC = 'oa-uc';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildUseCaseImpact: typeof import('@/lib/usecases/impact').buildUseCaseImpact;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ buildUseCaseImpact } = await import('@/lib/usecases/impact'));
  await sql.run(`INSERT INTO use_cases (id, title) VALUES (?, 'OpenAI impact')`, [UC]);
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local')`);
  await sql.run(`INSERT INTO use_case_activation_weeks (use_case_id, week_start, distinct_users, session_count, matched_messages, updated_at) VALUES (?, ?, 1, 3, 0, 1)`, [UC, WK]);
  for (const sid of ['chatgpt:a', 'codex:b', 'claude-c']) {
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'u1', ?)`, [UC, WK, sid]);
  }
  await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, active_secs, computed_at) VALUES ('chatgpt:a', 'u1', 'chatgpt_chat', ?, ?, 1800, ?)`, [WK + 100, WK + 2000, WK]);
  await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, model, occurred_at) VALUES ('r1', 'u1', 'chatgpt:a', 'chatgpt_chat', 'gpt-6', ?)`, [WK + 200]);
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, active_secs, models_json, computed_at) VALUES ('codex:b', 'u1', ?, ?, 900, '{}', ?)`, [WK + 100, WK + 1000, WK]);
  await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at) VALUES ('t1', 'u1', 'codex:b', 'gpt-6.1-sol', ?)`, [WK + 150]);
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, active_secs, models_json, computed_at) VALUES ('claude-c', 'u1', ?, ?, 600, '{"claude-sonnet-4-6":{}}', ?)`, [WK + 100, WK + 700, WK]);
});
afterAll(async () => cleanup());

describe('buildUseCaseImpact with ChatGPT and Codex', () => {
  it('counts and times each product apart, and lists OpenAI models', async () => {
    const impact = await buildUseCaseImpact(UC, NOW);
    expect(impact.participation.surfaces).toEqual({ cowork: 0, code: 1, chatgpt: 1, codex: 1 });
    expect(impact.totals.codeDurationSecs).toBe(600);
    expect(impact.totals.chatgptDurationSecs).toBe(1800);
    expect(impact.totals.codexDurationSecs).toBe(900);
    expect(impact.participation.models.map(m => m.name).sort()).toEqual(['claude-sonnet-4-6', 'gpt-6', 'gpt-6.1-sol']);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// So What's "used it once and hardly since": the count is the same as reading every prompt ever
// stored (the old query, kept here as the reference), in each vendor view, and the "ever used"
// look-up uses the per-vendor indexes from migration 0056 rather than reading all history.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { getWorkFinds } from '@/lib/pulse/cowork/so-what-finds';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { WORK_PULSE_SURFACES } from '@/lib/pulse/work-surfaces';

const NOW = 1_800_000_000;
const DAY = 86400;

let sql: TestSql;
let pool: Pool;
let cleanup: () => Promise<void>;
let seq = 0;

async function prompt(user: string, session: string, daysAgo: number, surface: string, source: string, type = 'cowork_user_message') {
  const id = `m${++seq}`;
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, session, user, type, surface, source, `prompt ${id}`, NOW - daysAgo * DAY]);
}

/** The old query: every Work Pulse prompt ever stored, grouped by person. */
async function reference(vendor: 'all' | 'claude' | 'openai'): Promise<number> {
  const row = await sql.get<{ people: number }>(`
    SELECT COUNT(*) AS people FROM (
      SELECT cm.user_id, COUNT(DISTINCT CASE WHEN cm.occurred_at >= ? THEN cm.session_id END) AS recent
      FROM cowork_messages cm
      WHERE cm.message_type = 'cowork_user_message' AND cm.user_id IS NOT NULL
        AND (cm.surface IN ('cowork', 'chat') OR cm.surface IS NULL) AND ${vendorClause(vendor, 'cm.')}
      GROUP BY cm.user_id
    ) q WHERE q.recent < 2`, [NOW - 90 * DAY]);
  return row!.people;
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  pool = (t.client as unknown as { $client: Pool }).$client;

  const people = ['steady', 'lapsed', 'once', 'gpt-steady', 'gpt-once', 'both', 'dev', 'nobody'];
  for (const p of people) await sql.run(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`, [p, `${p}@test.local`, p]);
  // Claude, two recent sessions: not counted.
  await prompt('steady', 's1', 5, 'cowork', 'otel');
  await prompt('steady', 's2', 10, 'chat', 'compliance');
  // Claude, busy long ago, nothing lately: counted.
  for (let i = 0; i < 5; i++) await prompt('lapsed', `l${i}`, 200 + i, 'cowork', 'otel');
  // Claude, one recent session: counted.
  await prompt('once', 'o1', 3, 'chat', 'compliance');
  await prompt('once', 'o1', 3, 'chat', 'compliance');
  // ChatGPT, two recent sessions: not counted.
  await prompt('gpt-steady', 'g1', 4, 'cowork', 'chatgpt_chat');
  await prompt('gpt-steady', 'g2', 6, 'cowork', 'chatgpt_work');
  // ChatGPT, used once long ago: counted.
  await prompt('gpt-once', 'g3', 300, 'cowork', 'chatgpt_chat');
  // One Claude session lately and ChatGPT long ago: counted in every view.
  await prompt('both', 'b1', 2, 'cowork', 'otel');
  await prompt('both', 'b2', 400, 'cowork', 'chatgpt_chat');
  // Developer Pulse only (code surface) and Claude's own replies: never Work Pulse prompts.
  await prompt('dev', 'd1', 1, 'code', 'otel', 'code_user_message');
  await prompt('dev', 'd2', 2, 'cowork', 'otel', 'cowork_api_request');
}, 120_000);

afterAll(async () => cleanup());

describe('So What: used it once and hardly since', () => {
  const empty = { rows: [], sessions: [], sessionsByUser: new Map<string, number>() };

  for (const vendor of ['all', 'claude', 'openai'] as const) {
    it(`counts the same as reading every prompt ever, in the ${vendor} view`, async () => {
      const finds = await getWorkFinds(vendor, empty, undefined, NOW);
      const expected = await reference(vendor);
      expect(expected).toBeGreaterThan(0);
      expect(finds.rarelyUsed?.people).toBe(expected);
    });
  }

  it('gives the counts the seeded people should give', async () => {
    expect(await reference('all')).toBe(4); // lapsed, once, gpt-once, both
    expect(await reference('claude')).toBe(3); // lapsed, once, both
    expect(await reference('openai')).toBe(2); // gpt-once, both
  });

  it('looks up "ever used" in the per-vendor indexes, not by reading every prompt', async () => {
    // The surfaces go in as parameters, as the app sends them.
    const surfaces = `(cm.surface IN ($1, $2) OR cm.surface IS NULL)`;
    const probe = (v: 'claude' | 'openai') => `EXISTS (SELECT 1 FROM cowork_messages cm WHERE cm.user_id = u.id
      AND cm.message_type = 'cowork_user_message' AND ${surfaces} AND ${vendorClause(v, 'cm.')})`;
    const conn = await pool.connect();
    try {
      // The test table is tiny, so the planner would read it whole anyway; ask it not to, to see
      // whether the index can be used at all.
      await conn.query('SET enable_seqscan = off');
      for (const [v, index] of [['claude', 'idx_cowork_wp_people_claude'], ['openai', 'idx_cowork_wp_people_openai']] as const) {
        const { rows } = await conn.query(`EXPLAIN SELECT COUNT(*) FROM users u WHERE ${probe(v)}`, [...WORK_PULSE_SURFACES]);
        const plan = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
        expect(plan, `${v} view`).toContain(index);
      }
    } finally {
      await conn.query('RESET enable_seqscan');
      conn.release();
    }
  });
});

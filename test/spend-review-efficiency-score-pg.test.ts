// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review "Most efficient" score, on Postgres:
// - the score is the median, across a person's comparable sessions, of each
//   session's spend over colleagues' median session spend for that kind of work;
// - a person whose work is spread over many kinds, a session or two each,
//   ranks once their comparable sessions add up to the minimum;
// - the index counts how far people got towards each board, so an empty board
//   can say why.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const HOUR = 3600;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const NOW = SEPT + 25 * DAY;
const KINDS = ['analysis', 'writing', 'research', 'planning', 'summarisation'];

async function setUp() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle inserts across many tables in a test
  const db = client as any;
  await db.insert(schema.users).values(['u-mia', 'u-p1', 'u-p2', 'u-p3'].map(id => ({
    id, email: `${id}@test.local`, display_name: id, department: 'Sales', source: 'otel',
  })));
  let n = 0;
  let hour = SEPT + 2 * DAY;
  async function coworkSession(userId: string, taskType: string, cost: number) {
    const sid = `cw-${++n}`;
    const t = (hour += HOUR);
    await db.insert(schema.coworkMessages).values([
      { id: `${sid}-p`, session_id: sid, user_id: userId, message_type: 'cowork_user_message', content_full: `prompt ${n}`, occurred_at: t, surface: 'cowork' },
      { id: `${sid}-a`, session_id: sid, user_id: userId, message_type: 'cowork_api_request', model: 'claude-sonnet-4-6', cost_usd: String(cost), occurred_at: t + 60, surface: 'cowork' },
    ]);
    await db.insert(schema.pulseClassifications).values({
      cowork_message_id: `${sid}-p`, user_id: userId, tier: 3, task_type: taskType,
      classifier_confidence: 0.9, classifier_model: 'test', classified_at: t,
    });
  }
  return { cleanup, coworkSession };
}

describe('spend review efficiency score (postgres)', () => {
  it('scores the median of per-session ratios, so work spread over many kinds ranks', async () => {
    const { cleanup, coworkSession } = await setUp();
    try {
      // Three colleagues: two $4 sessions of each of five kinds of work (median $4 for every kind).
      for (const p of ['u-p1', 'u-p2', 'u-p3']) for (const k of KINDS) for (let i = 0; i < 2; i++) await coworkSession(p, k, 4);
      // Mia: two sessions of each of the five kinds, ten in all. Four kinds at $2 a session
      // (half colleagues' $4), and analysis at $40 a session (ten times).
      for (const k of KINDS) for (let i = 0; i < 2; i++) await coworkSession('u-mia', k, k === 'analysis' ? 40 : 2);

      const { buildSpendReviewIndex, EFFICIENCY_MIN_SESSIONS } = await import('@/lib/finance/spend-review');
      const index = await buildSpendReviewIndex(PERIOD, NOW);

      // Ratios 0.5 (x8) and 10 (x2): the median is 0.5.
      // The old score, each kind's median weighted by spend, was (16 * 0.5 + 80 * 10) / 96 = 8.4: she would not have ranked.
      expect(index.efficiency.map(e => e.userId)).toEqual(['u-mia']);
      expect(index.efficiency[0].vsColleagues).toBeCloseTo(0.5, 6);
      // Two sessions per kind, ten comparable sessions in all: the minimum.
      expect(index.efficiency[0].sessions).toBe(EFFICIENCY_MIN_SESSIONS);
      expect(index.efficiency[0].deepRate).toBe(1);
      expect(index.efficiency[0].peerDeepRate).toBe(1);

      // Everyone had ten comparable sessions; only Mia cost less than colleagues (each colleague's median ratio is 1).
      expect(index.summary.efficiencyReach?.claude).toEqual({ compared: 4, mostSessions: 10, enough: 4, cheaper: 1, minSessions: EFFICIENCY_MIN_SESSIONS });
    } finally {
      await cleanup();
    }
  });

  it('counts how far people got when a board is empty', async () => {
    const { cleanup, coworkSession } = await setUp();
    try {
      // Colleagues: two $4 sessions of each of three kinds; Mia: two $1 sessions of each. Six sessions each, under ten.
      for (const p of ['u-p1', 'u-p2', 'u-p3']) for (const k of KINDS.slice(0, 3)) for (let i = 0; i < 2; i++) await coworkSession(p, k, 4);
      for (const k of KINDS.slice(0, 3)) for (let i = 0; i < 2; i++) await coworkSession('u-mia', k, 1);
      // A kind of work no colleague does has nothing to compare against and adds nothing.
      await coworkSession('u-mia', 'one-off', 1);

      const { buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const index = await buildSpendReviewIndex(PERIOD, NOW);

      expect(index.efficiency).toEqual([]);
      // Four people had sessions to compare, the most anyone had was six, and the board needs ten.
      expect(index.summary.efficiencyReach?.claude).toEqual({ compared: 4, mostSessions: 6, enough: 0, cheaper: 0, minSessions: 10 });
    } finally {
      await cleanup();
    }
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review index with Claude and OpenAI work, on Postgres:
// - "Most efficient this month" is two boards, Claude's (Code and Cowork) and
//   OpenAI's (ChatGPT and Codex), each scoring people on that vendor's work
//   only, never mixed;
// - "Spend so far" carries FinOps's Claude / OpenAI split, and last month's
//   beside it (a Claude-only last month counts as all Claude);
// - with ChatGPT and Codex hidden there is no OpenAI board and no split.
//
// Ana is cheap on Claude Cowork and dear on ChatGPT; Pat is cheap on ChatGPT
// and dear on Cowork. Mixed into one score, neither would rank; scored per
// vendor, Ana tops Claude's board and Pat OpenAI's.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const HOUR = 3600;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const AUG = Date.UTC(2026, 7, 1) / 1000;
const NOW = SEPT + 25 * DAY;
const TERRA = 'gpt-6.1-terra'; // $1 per million input tokens

describe('spend review efficiency boards by vendor (postgres)', () => {
  it('scores Claude and OpenAI work on separate boards and splits the month by vendor', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle inserts across many tables in a test
      const db = client as any;
      await db.insert(schema.users).values(['u-ana', 'u-pat', 'u-p2', 'u-p3'].map(id => ({
        id, email: `${id}@test.local`, display_name: id, department: 'Sales', source: 'otel',
      })));

      let n = 0;
      let hour = SEPT + 2 * DAY;
      async function coworkSession(userId: string, cost: number, when?: number) {
        const sid = `cw-${++n}`;
        const t = when ?? (hour += HOUR);
        await db.insert(schema.coworkMessages).values([
          { id: `${sid}-p`, session_id: sid, user_id: userId, message_type: 'cowork_user_message', content_full: `prompt ${n}`, occurred_at: t, surface: 'cowork' },
          { id: `${sid}-a`, session_id: sid, user_id: userId, message_type: 'cowork_api_request', model: 'claude-sonnet-4-6', cost_usd: String(cost), occurred_at: t + 60, surface: 'cowork' },
        ]);
        await db.insert(schema.pulseClassifications).values({
          cowork_message_id: `${sid}-p`, user_id: userId, tier: 3, task_type: 'analysis',
          classifier_confidence: 0.9, classifier_model: 'test', classified_at: t,
        });
      }
      /** A ChatGPT conversation alone in its hour, so it carries that hour's whole cost. */
      async function chatgptConversation(userId: string, cost: number) {
        const sid = `chatgpt:c${++n}`;
        const h = (hour += HOUR);
        await db.insert(schema.coworkMessages).values({
          id: `${sid}-p`, session_id: sid, user_id: userId, message_type: 'cowork_user_message',
          content_full: `prompt ${n}`, occurred_at: h + 30, surface: 'cowork', source: 'chatgpt_chat',
        });
        await db.insert(schema.pulseClassifications).values({
          cowork_message_id: `${sid}-p`, user_id: userId, tier: 3, task_type: 'analysis',
          classifier_confidence: 0.9, classifier_model: 'test', classified_at: h,
        });
        await db.insert(schema.openaiReplies).values({ id: `${sid}-r`, user_id: userId, session_id: sid, source: 'chatgpt_chat', model: TERRA, occurred_at: h + 60 });
        await db.insert(schema.openaiCosts).values({
          id: `oc-${n}`, user_id: userId, hour_start: h, product: 'chatgpt', model: TERRA,
          input_tokens: Math.round(cost * 1_000_000), cached_input_tokens: 0, output_tokens: 0, cost_usd: '0', billed_in: 'usd',
        });
      }

      // Claude Cowork analysis: Ana 10 x $1, Pat 10 x $8, two colleagues 4 x $4.
      for (let i = 0; i < 10; i++) await coworkSession('u-ana', 1);
      for (let i = 0; i < 10; i++) await coworkSession('u-pat', 8);
      for (const p of ['u-p2', 'u-p3']) for (let i = 0; i < 4; i++) await coworkSession(p, 4);
      // ChatGPT analysis: Ana 10 x $4, Pat 10 x $0.50, two colleagues 4 x $1.
      for (let i = 0; i < 10; i++) await chatgptConversation('u-ana', 4);
      for (let i = 0; i < 10; i++) await chatgptConversation('u-pat', 0.5);
      for (const p of ['u-p2', 'u-p3']) for (let i = 0; i < 4; i++) await chatgptConversation(p, 1);
      // Last month: Claude only, $20.
      await coworkSession('u-ana', 20, AUG + 3 * DAY);

      const { buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const { buildChargeback } = await import('@/lib/finance/chargeback');
      const index = await buildSpendReviewIndex(PERIOD, NOW);

      // Never mixed: each board ranks on its own vendor's work.
      expect(index.efficiency.map(e => e.userId)).toEqual(['u-ana']);
      expect(index.efficiency[0].sessions).toBe(10);
      expect(index.efficiencyOpenai.map(e => e.userId)).toEqual(['u-pat']);
      expect(index.efficiencyOpenai[0].sessions).toBe(10);
      // Ana's Claude median $1 against colleagues' $8/$4 sessions (median $8): 0.125.
      expect(index.efficiency[0].vsColleagues).toBeCloseTo(1 / 8, 6);
      // Pat's ChatGPT median $0.50 against colleagues' $4/$1 sessions (median $4): 0.125.
      expect(index.efficiencyOpenai[0].vsColleagues).toBeCloseTo(0.5 / 4, 6);

      // Spend so far by vendor: FinOps's own split, and last month's (all Claude).
      const report = await buildChargeback(PERIOD, NOW);
      expect(index.summary.totalUsd).toBeCloseTo(report.grandTotalUsd, 6);
      expect(index.summary.vendors).toEqual({ claudeUsd: expect.closeTo(report.vendors!.claudeUsd, 6), openaiUsd: expect.closeTo(report.vendors!.openaiUsd, 6) });
      expect(index.summary.vendors!.claudeUsd).toBeCloseTo(10 + 80 + 32, 6);
      expect(index.summary.vendors!.openaiUsd).toBeCloseTo(40 + 5 + 8, 6);
      expect(index.summary.priorVendors).toEqual({ claudeUsd: expect.closeTo(20, 6), openaiUsd: 0 });

      // The working figures never leave the engine.
      expect(index.people.every(p => !('_efficiency' in p))).toBe(true);

      // The report section carries both boards, each on its own vendor's work.
      const { buildSpendReviewSection } = await import('@/lib/reports/spend-review-sections');
      const md = await buildSpendReviewSection('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z');
      const claudeAt = md.indexOf('#### Most efficient on Claude in September 2026');
      const openaiAt = md.indexOf('#### Most efficient on ChatGPT and Codex in September 2026');
      expect(claudeAt).toBeGreaterThan(-1);
      expect(openaiAt).toBeGreaterThan(claudeAt);
      expect(md.slice(claudeAt, openaiAt)).toContain('| 1 | u-ana |');
      expect(md.slice(claudeAt, openaiAt)).not.toContain('| u-pat |');
      expect(md.slice(openaiAt)).toContain('| 1 | u-pat |');

      // ChatGPT and Codex hidden: no OpenAI board and no split; Claude's board unchanged.
      const { setConfigValue } = await import('@/lib/config');
      await setConfigValue('openaiShown', 'false');
      const hidden = await buildSpendReviewIndex(PERIOD, NOW);
      expect(hidden.efficiencyOpenai).toEqual([]);
      expect(hidden.summary.vendors).toBeUndefined();
      expect(hidden.efficiency.map(e => e.userId)).toEqual(['u-ana']);
      const hiddenMd = await buildSpendReviewSection('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z');
      expect(hiddenMd).toContain('#### Most efficient on Claude in September 2026');
      expect(hiddenMd).not.toContain('Most efficient on ChatGPT and Codex');
    } finally {
      await cleanup();
    }
  });
});

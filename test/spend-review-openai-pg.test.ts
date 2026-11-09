// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review with ChatGPT and Codex on Postgres: a person's ChatGPT
// conversations carry their share of each hour's cost, Codex sessions their
// turns' cost, both grouped by kind of work; the totals equal FinOps's for the
// person (unmatched ChatGPT cost included); colleagues are compared only
// within the same product; and the index carries the same figures.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const NOW = SEPT + 20 * DAY;
const TERRA = 'gpt-6.1-terra'; // $1 in / $5 out per MTok
const PRO = 'gpt-6-pro';       // $10 in / $50 out per MTok

describe('spend review with OpenAI (postgres)', () => {
  it('reviews ChatGPT and Codex spend beside Claude and matches FinOps', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const db = client as any;

      const people = ['u-ana', 'u-p1', 'u-p2', 'u-p3'].map((id, i) => ({
        id, email: `${id}@test.local`, display_name: `Person ${i}`, department: 'Sales', source: 'openai',
      }));
      await db.insert(schema.users).values(people);

      let n = 0;
      /** A ChatGPT conversation: one prompt, classified, and `replies` replies in the hour starting `hour`. */
      async function chatgptConversation(userId: string, hour: number, model: string, replies: number, taskType: string) {
        const sid = `chatgpt:c${++n}`;
        const promptId = `${sid}-p`;
        await db.insert(schema.coworkMessages).values({
          id: promptId, session_id: sid, user_id: userId, message_type: 'cowork_user_message',
          content_full: `prompt ${n}`, occurred_at: hour + 30, surface: 'cowork', source: 'chatgpt_chat',
        });
        await db.insert(schema.pulseClassifications).values({
          cowork_message_id: promptId, user_id: userId, tier: 2, task_type: taskType,
          classifier_confidence: 0.9, classifier_model: 'test', classified_at: hour,
        });
        for (let i = 0; i < replies; i++) {
          await db.insert(schema.openaiReplies).values({ id: `${sid}-r${i}`, user_id: userId, session_id: sid, source: 'chatgpt_chat', model, occurred_at: hour + 60 + i });
        }
        return sid;
      }
      async function hourCost(userId: string, hour: number, model: string, inputTokens: number) {
        await db.insert(schema.openaiCosts).values({
          id: `oc-${++n}`, user_id: userId, hour_start: hour, product: 'chatgpt', model,
          input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 0, cost_usd: '0', billed_in: 'usd',
        });
      }
      async function codexSession(userId: string, at: number, model: string, outputTokens: number, workType: string) {
        const sid = `codex:s${++n}`;
        await db.insert(schema.codexTurns).values({ id: `${sid}-t`, user_id: userId, session_id: sid, model, started_at: at, uncached_input_tokens: 0, cached_input_tokens: 0, output_tokens: outputTokens });
        await db.insert(schema.codeSessionStats).values({ session_id: sid, user_id: userId, first_at: at, last_at: at + 600, active_secs: 600, user_msg_count: 2, tool_use_count: 3, commit_count: 1, computed_at: at });
        await db.insert(schema.codeSessionClassifications).values({ session_id: sid, user_id: userId, work_type: workType, tier: 2, confidence: 0.9, classifier_model: 'test', status: 'classified', classified_at: at });
        return sid;
      }

      // Ana: one hour of gpt-6-pro, $3 over three replies: two in conversation A, one in B.
      const h1 = SEPT + 2 * DAY;
      const a = await chatgptConversation('u-ana', h1, PRO, 2, 'analysis');
      const b = await chatgptConversation('u-ana', h1, PRO, 1, 'analysis');
      await hourCost('u-ana', h1, PRO, 300_000); // 0.3M x $10 = $3
      // An hour with no reply on record: $1, in her total but in no conversation.
      await hourCost('u-ana', h1 + 5 * 3600, TERRA, 1_000_000);
      // Codex: 200k output tokens of gpt-6.1-terra = $1.
      const cx = await codexSession('u-ana', h1, TERRA, 200_000, 'feature');

      const { buildSpendReview, buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const { buildChargeback } = await import('@/lib/finance/chargeback');
      const review = await buildSpendReview('u-ana', PERIOD, NOW);

      expect(review.openai).toBe(true);
      expect(review.totals.chatgptUsd).toBeCloseTo(4, 6);
      expect(review.totals.chatgptUnmatchedUsd).toBeCloseTo(1, 6);
      expect(review.totals.codexUsd).toBeCloseTo(1, 6);
      expect(review.totals.totalUsd).toBeCloseTo(5, 6);

      const byId = new Map(review.sessions.map(s => [s.sessionId, s]));
      expect(byId.get(a)).toMatchObject({ surface: 'chatgpt', workKey: 'analysis' });
      expect(byId.get(a)!.spendUsd).toBeCloseTo(2, 6);
      expect(byId.get(b)!.spendUsd).toBeCloseTo(1, 6);
      expect(byId.get(cx)).toMatchObject({ surface: 'codex', workKey: 'feature', commits: 1 });
      expect(byId.get(cx)!.spendUsd).toBeCloseTo(1, 6);

      const chatgptWork = review.work.find(w => w.key === 'chatgpt:analysis')!;
      expect(chatgptWork.spendUsd).toBeCloseTo(3, 6);
      expect(chatgptWork.sessions).toBe(2);
      expect(review.work.find(w => w.key === 'codex:feature')!.commits).toBe(1);

      // FinOps prices the same records the same way.
      const report = await buildChargeback(PERIOD, NOW);
      const fin = [...report.costCentres.flatMap(c => c.users), ...report.unallocated.users].find(u => u.userId === 'u-ana')!;
      expect(fin.totalUsd).toBeCloseTo(review.totals.totalUsd, 6);
      expect(fin.chatgptUsd).toBeCloseTo(review.totals.chatgptUsd, 6);

      // Colleagues: three others doing ChatGPT analysis on gpt-6.1-terra make a population;
      // Ana's analysis is compared with them, and only OpenAI models appear.
      for (const p of ['u-p1', 'u-p2', 'u-p3']) {
        for (let i = 0; i < 3; i++) {
          const h = SEPT + (3 + i) * DAY + 3600 * Number(p.slice(-1));
          await chatgptConversation(p, h, TERRA, 1, 'analysis');
          await hourCost(p, h, TERRA, 100_000);
        }
      }
      const again = await buildSpendReview('u-ana', PERIOD, NOW);
      const w2 = again.work.find(w => w.key === 'chatgpt:analysis')!;
      expect(w2.peer).toMatchObject({ users: 3, sessions: 9 });
      expect(w2.models.every(m => !m.model.startsWith('claude-'))).toBe(true);

      const index = await buildSpendReviewIndex(PERIOD, NOW);
      expect(index.openai).toBe(true);
      const ana = index.people.find(p => p.userId === 'u-ana')!;
      expect(ana.totalUsd).toBeCloseTo(5, 6);
      expect(ana.chatgptUsd).toBeCloseTo(4, 6);
      expect(ana.codexUsd).toBeCloseTo(1, 6);
      expect(ana.mainWork).toMatchObject({ surface: 'chatgpt' });
    } finally {
      await cleanup();
    }
  });
});

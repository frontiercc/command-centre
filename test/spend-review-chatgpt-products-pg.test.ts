// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT model advice on Postgres names only a model the person can pick where they use
// their current one: ChatGPT Work offers GPT-6.1 Terra, the Chat tab does not (OpenAI's rate
// card). Someone who did the same work in both is advised for the model they use most, by
// where that model's sessions ran. The person page and the index agree.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const NOW = SEPT + 25 * DAY;
const TERRA = 'gpt-6.1-terra'; // Work and Codex only
const ASTRA = 'gpt-6-astra';   // Work and Codex
const PRO = 'gpt-6-pro';       // Chat only

describe('ChatGPT advice by where the work ran (postgres)', () => {
  it('suggests a Work-only model only for work done in ChatGPT Work', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      const ids = ['u-ana', 'u-bo', 'u-p1', 'u-p2', 'u-p3'];
      await db.insert(schema.users).values(ids.map((id, i) => ({ id, email: `${id}@test.local`, display_name: `Person ${i}`, department: 'Sales', source: 'openai' })));

      let n = 0;
      /** One conversation of analysis in `source`, one reply, and its hour's cost. */
      async function conversation(userId: string, hour: number, model: string, source: 'chatgpt_chat' | 'chatgpt_work', inputTokens: number) {
        const sid = `chatgpt:c${++n}`;
        await db.insert(schema.coworkMessages).values({
          id: `${sid}-p`, session_id: sid, user_id: userId, message_type: 'cowork_user_message',
          content_full: `prompt ${n}`, occurred_at: hour + 30, surface: 'cowork', source,
        });
        await db.insert(schema.pulseClassifications).values({
          cowork_message_id: `${sid}-p`, user_id: userId, tier: 2, task_type: 'analysis',
          classifier_confidence: 0.9, classifier_model: 'test', classified_at: hour,
        });
        await db.insert(schema.openaiReplies).values({ id: `${sid}-r`, user_id: userId, session_id: sid, source, model, occurred_at: hour + 60 });
        await db.insert(schema.openaiCosts).values({
          id: `oc-${n}`, user_id: userId, hour_start: hour, product: 'chatgpt', model,
          input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 0, cost_usd: '0', billed_in: 'usd',
        });
      }
      const hour = (day: number, h: number) => SEPT + day * DAY + h * 3600;

      // Ana: two sessions on GPT-6 Astra in ChatGPT Work, one on GPT-6 Pro in Chat.
      await conversation('u-ana', hour(2, 1), ASTRA, 'chatgpt_work', 1_000_000);
      await conversation('u-ana', hour(2, 2), ASTRA, 'chatgpt_work', 1_000_000);
      await conversation('u-ana', hour(2, 3), PRO, 'chatgpt_chat', 1_000_000);
      // Bo: three sessions on GPT-6 Pro in Chat.
      for (let i = 0; i < 3; i++) await conversation('u-bo', hour(3, i + 1), PRO, 'chatgpt_chat', 1_000_000);
      // Colleagues: 21 sessions of analysis on GPT-6.1 Terra in ChatGPT Work.
      for (let i = 0; i < 21; i++) await conversation(`u-p${(i % 3) + 1}`, hour(4 + Math.floor(i / 3), (i % 3) + 1), TERRA, 'chatgpt_work', 100_000);

      const { buildSpendReview, buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const modelRoutes = async (u: string) => (await buildSpendReview(u, PERIOD, NOW)).work
        .find(w => w.key === 'chatgpt:analysis')!.routes.filter(r => r.kind === 'model');

      // Ana uses Astra most, in Work, where Terra is offered.
      expect(await modelRoutes('u-ana')).toEqual([expect.objectContaining({ direction: 'save', fromModel: ASTRA, toModel: TERRA })]);
      // Bo works in Chat, where Terra is not offered.
      expect((await modelRoutes('u-bo')).some(r => r.kind === 'model' && r.toModel === TERRA)).toBe(false);

      const index = await buildSpendReviewIndex(PERIOD, NOW);
      expect(index.people.find(p => p.userId === 'u-ana')!.routeCount).toBe(1);
      expect(index.people.find(p => p.userId === 'u-bo')!.routeCount).toBe((await modelRoutes('u-bo')).length);
    } finally {
      await cleanup();
    }
  });
});

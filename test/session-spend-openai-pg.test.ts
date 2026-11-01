// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Audit Log's where-the-money-went for ChatGPT and Codex: each reply or
// turn counts towards the latest prompt before it; a ChatGPT reply's cost is
// its share of its hour's cost (shared with the person's other conversations
// in that hour), a Codex turn's tokens are priced exactly.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';
import { promptAt } from '@/lib/finance/session-spend';

const H = Math.floor(Date.UTC(2026, 9, 5, 10) / 1000); // an hour boundary
const TERRA = 'gpt-6.1-terra'; // $1 in / $5 out per MTok

describe('promptAt', () => {
  it('picks the latest prompt at or before the call, else the first', () => {
    const prompts = [{ id: 'a', at: 100 }, { id: 'b', at: 200 }];
    expect(promptAt(prompts, 50)).toBe('a');
    expect(promptAt(prompts, 150)).toBe('a');
    expect(promptAt(prompts, 200)).toBe('b');
    expect(promptAt(prompts, 999)).toBe('b');
    expect(promptAt([], 1)).toBeNull();
  });
});

describe('session spend for ChatGPT and Codex (postgres)', () => {
  it('splits a conversation by prompt', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { buildSessionSpend } = await import('@/lib/finance/session-spend');
      const db = client as any;
      await db.insert(schema.users).values({ id: 'u1', email: 'u1@test.local', display_name: 'u1', source: 'openai' });

      // ChatGPT: prompts p1 (H+10) and p2 (H+1000) in conversation A; three replies in the hour,
      // two in A (one after each prompt) and one in another conversation B. The hour cost $3.
      await db.insert(schema.coworkMessages).values([
        { id: 'p1', session_id: 'chatgpt:A', user_id: 'u1', message_type: 'cowork_user_message', occurred_at: H + 10, surface: 'cowork', source: 'chatgpt_chat' },
        { id: 'p2', session_id: 'chatgpt:A', user_id: 'u1', message_type: 'cowork_user_message', occurred_at: H + 1000, surface: 'cowork', source: 'chatgpt_chat' },
      ]);
      await db.insert(schema.openaiReplies).values([
        { id: 'r1', user_id: 'u1', session_id: 'chatgpt:A', source: 'chatgpt_chat', model: TERRA, occurred_at: H + 20 },
        { id: 'r2', user_id: 'u1', session_id: 'chatgpt:A', source: 'chatgpt_chat', model: TERRA, occurred_at: H + 1010 },
        { id: 'r3', user_id: 'u1', session_id: 'chatgpt:B', source: 'chatgpt_chat', model: TERRA, occurred_at: H + 2000 },
      ]);
      await db.insert(schema.openaiCosts).values({ id: 'oc1', user_id: 'u1', hour_start: H, product: 'chatgpt', model: TERRA, input_tokens: 3_000_000, cached_input_tokens: 0, output_tokens: 0, billed_in: 'usd' });

      const a = await buildSessionSpend('chatgpt:A', 'p2');
      expect(a.surface).toBe('chatgpt');
      expect(a.userId).toBe('u1');
      expect(a.conversation.totalUsd).toBeCloseTo(2, 6);
      expect(a.conversation.calls).toBe(2);
      expect(a.prompt?.totalUsd).toBeCloseTo(1, 6);
      expect(a.prompt?.calls).toBe(1);

      // Codex: prompt q1 then two turns, prompt q2 then one turn. 200k output tokens each = $1.
      await db.insert(schema.coworkMessages).values([
        { id: 'q1', session_id: 'codex:X', user_id: 'u1', message_type: 'code_user_message', occurred_at: H, surface: 'code', source: 'codex' },
        { id: 'q2', session_id: 'codex:X', user_id: 'u1', message_type: 'code_user_message', occurred_at: H + 500, surface: 'code', source: 'codex' },
      ]);
      await db.insert(schema.codexTurns).values([
        { id: 't1', user_id: 'u1', session_id: 'codex:X', model: TERRA, started_at: H + 10, output_tokens: 200_000 },
        { id: 't2', user_id: 'u1', session_id: 'codex:X', model: TERRA, started_at: H + 20, output_tokens: 200_000 },
        { id: 't3', user_id: 'u1', session_id: 'codex:X', model: TERRA, started_at: H + 510, output_tokens: 200_000 },
      ]);
      const x = await buildSessionSpend('codex:X', 'q1');
      expect(x.surface).toBe('codex');
      expect(x.conversation.totalUsd).toBeCloseTo(3, 6);
      expect(x.prompt?.totalUsd).toBeCloseTo(2, 6);
      expect(x.prompt?.calls).toBe(2);
      expect(x.conversation.byModel.map(m => m.name)).toEqual([TERRA]);
    } finally {
      await cleanup();
    }
  });
});

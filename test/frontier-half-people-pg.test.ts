// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Frontier work rests on N people": the fewest people who together do half of
// the frontier work. On the All view it is Claude's figure plus ChatGPT's, each
// worked out on its own product's work, so it adds up like every All-view figure.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'me@test.com' }) };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const { schema } = await import('@/lib/db/schema');
  await client.insert(schema.users).values(['a', 'b', 'c', 'd'].map(id => ({ id, email: `${id}@corp.com` })));
  // Frontier tasks per person and product, all inside the last 30 days:
  // Claude a 6, b 2, c 2 (half of 10 needs a alone: 1); ChatGPT a 3, d 3 (half of 6 needs 1).
  // Counted together, the half would be a-on-Claude alone (6 of 16 is not half) plus one more: 2.
  const work: Array<[string, string, number]> = [
    ['a', 'otel', 6], ['b', 'otel', 2], ['c', 'otel', 2], ['a', 'chatgpt_chat', 3], ['d', 'chatgpt_chat', 3],
  ];
  let i = 0;
  for (const [user, source, n] of work) {
    for (let k = 0; k < n; k++) {
      const id = `m${i++}`;
      await client.insert(schema.coworkMessages).values({
        id, session_id: `${source === 'otel' ? '' : 'chatgpt:'}s-${user}`, user_id: user, message_type: 'cowork_user_message',
        surface: 'cowork', source, occurred_at: NOW - 2 * DAY,
      });
      await client.insert(schema.pulseClassifications).values({
        cowork_message_id: id, user_id: user, tier: 3, task_type: 'analysis', classifier_status: 'classified', classifier_confidence: 0.9, classifier_model: 'test', classified_at: NOW - 2 * DAY,
      });
    }
  }
}, 120_000);

afterAll(async () => cleanup?.());

async function half(vendor: 'all' | 'claude' | 'openai') {
  const { GET } = await import('../app/api/pulse/org-summary/route');
  const body = await (await GET(new NextRequest(`http://localhost/api/pulse/org-summary?vendor=${vendor}`))).json();
  return body.dashboard as { frontierHalfPeople: number | null; frontierHalfSplit: { claude: number; openai: number } | null; frontierPeople30d: number };
}

describe('frontier work rests on N people', () => {
  it('is Claude plus ChatGPT on the All view, with the split', async () => {
    const [all, claude, openai] = [await half('all'), await half('claude'), await half('openai')];
    expect(claude.frontierHalfPeople).toBe(1);
    expect(openai.frontierHalfPeople).toBe(1);
    expect(all.frontierHalfPeople).toBe(claude.frontierHalfPeople! + openai.frontierHalfPeople!);
    expect(all.frontierHalfSplit).toEqual({ claude: 1, openai: 1 });
    expect(all.frontierPeople30d).toBe(claude.frontierPeople30d + openai.frontierPeople30d);
  });
});

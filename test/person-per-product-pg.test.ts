// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// People figures on an All view count a person once for each vendor they used
// (personPerProduct), so All is the Claude figure plus the OpenAI figure. A
// person on both is in both, which is why All can exceed the number of people.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

const NOW = Math.floor(Date.now() / 1000);

let cleanup: () => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  client = h.client;
  const { schema } = await import('@/lib/db/schema');
  await client.insert(schema.users).values([
    { id: 'both', email: 'both@corp.com' },
    { id: 'claude-only', email: 'claude@corp.com' },
    { id: 'chatgpt-only', email: 'chatgpt@corp.com' },
  ]);
  await client.insert(schema.coworkMessages).values([
    { id: 'm1', session_id: 's1', user_id: 'both', message_type: 'cowork_user_message', surface: 'cowork', source: 'otel', occurred_at: NOW },
    { id: 'm2', session_id: 's2', user_id: 'both', message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_chat', occurred_at: NOW },
    { id: 'm3', session_id: 's3', user_id: 'claude-only', message_type: 'cowork_user_message', surface: 'chat', source: 'compliance', occurred_at: NOW },
    { id: 'm4', session_id: 's4', user_id: 'chatgpt-only', message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_work', occurred_at: NOW },
  ]);
}, 120_000);

afterAll(async () => cleanup?.());

describe('personPerProduct', () => {
  it('makes the All count the Claude count plus the OpenAI count', async () => {
    const { vendorClause, personPerProduct } = await import('@/lib/dashboard/product-sql');
    const count = async (vendor: 'all' | 'claude' | 'openai') => {
      const rows = await client.execute(sql.raw(
        `SELECT COUNT(DISTINCT ${personPerProduct('cm.')}) AS n FROM cowork_messages cm WHERE ${vendorClause(vendor, 'cm.')}`));
      return Number((rows.rows ?? rows)[0].n);
    };
    const claude = await count('claude');
    const openai = await count('openai');
    expect(claude).toBe(2);
    expect(openai).toBe(2);
    expect(await count('all')).toBe(claude + openai);
  });
});

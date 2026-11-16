// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's "N flagged for PII" counts personal data only, over the same
// 4 weeks as the card it sits under: not risky-intent flags, not flags the
// confirmation check fully dismissed, and nothing older than 4 weeks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
  await client.insert(schema.users).values({ id: 'u', email: 'u@corp.com' });
  const row = (id: string, reason: string, daysAgo: number, source = 'otel') => ({
    id, session_id: `s-${id}`, user_id: 'u', message_type: 'cowork_user_message', surface: 'cowork', source,
    flagged: 1, flag_reason: reason, occurred_at: NOW - daysAgo * DAY,
  });
  await client.insert(schema.coworkMessages).values([
    row('pii', 'PII detected: email', 2),
    row('pii-gpt', 'PII detected: uk_phone', 3, 'chatgpt_work'),
    row('mixed', 'PII detected: iban (dismissed), email | Intent detected: shadow_it', 4),
    row('intent', 'Intent detected: reconnaissance', 2),
    row('dismissed', 'PII detected: aws_key (dismissed)', 2),
    row('old', 'PII detected: email', 40),
  ]);
}, 120_000);

afterAll(async () => cleanup?.());

describe('dashboard flagged for PII', () => {
  it('counts live personal-data flags in the last 4 weeks only', async () => {
    const { getFlaggedByProduct } = await import('@/lib/dashboard/queries');
    const f = await getFlaggedByProduct(NOW);
    // pii and mixed (one live type) on Claude; pii-gpt on ChatGPT. Not intent, dismissed or old.
    expect(f.work).toEqual({ total: 3, claude: 2, openai: 1 });
  });
});

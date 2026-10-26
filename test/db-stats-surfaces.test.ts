// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The admin Database Health card needs honest per-surface counts.
// cowork_messages holds BOTH code and cowork rows (surface column) — the old
// combined coworkCount stays for API compatibility; the split is additive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('getDbStats per-surface split', () => {
  let cleanup: () => Promise<void>;
  let queries: typeof import('@/lib/db/queries');
  let client: Awaited<ReturnType<typeof import('@/lib/db/client').getTypedClient>>;
  let schema: typeof import('@/lib/db/schema').schema;

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    queries = await import('@/lib/db/queries');
    client = await (await import('@/lib/db/client')).getTypedClient();
    schema = (await import('@/lib/db/schema')).schema;

    const nowS = Math.floor(Date.now() / 1000);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: nowS, last_seen_at: nowS });
    // 2 code rows + 1 cowork row, one of them OTel-sourced with a known timestamp
    await client.insert(schema.coworkMessages).values([
      { id: 'm1', session_id: 's1', user_id: 'u1', message_type: 'code_user_message', surface: 'code', source: 'otel', occurred_at: nowS - 100, ingested_at: nowS },
      { id: 'm2', session_id: 's1', user_id: 'u1', message_type: 'code_user_message', surface: 'code', source: 'otel', occurred_at: nowS - 50, ingested_at: nowS },
      { id: 'm3', session_id: 's2', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', source: 'otel', occurred_at: nowS - 200, ingested_at: nowS },
    ]);
  });
  afterAll(async () => cleanup());

  it('splits code vs cowork while keeping the combined count', async () => {
    const stats = await queries.getDbStats();
    expect(stats.codeCount).toBe(2);
    expect(stats.coworkOnlyCount).toBe(1);
    expect(stats.coworkCount).toBe(3); // unchanged combined field
  });

  it('reports the latest OTel-sourced event timestamp', async () => {
    const stats = await queries.getDbStats();
    const nowS = Math.floor(Date.now() / 1000);
    expect(stats.latestOtelEventAt).toBeGreaterThanOrEqual(nowS - 60);
    expect(stats.latestOtelEventAt).toBeLessThanOrEqual(nowS);
  });
});

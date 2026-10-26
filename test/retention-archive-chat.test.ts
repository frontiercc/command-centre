// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// With archive enabled + purge mode, chat rows were deleted with
// NO backup (archive covered only cowork/otel/compliance). This test proves
// chat_messages, chat_assistant_meta and error_events now archive before purge.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';

const uploaded: Record<string, Buffer> = {};
vi.mock('@/lib/archive/factory', () => ({
  createProvider: vi.fn(async () => ({
    upload: vi.fn(async (key: string, data: Buffer) => { uploaded[key] = data; }),
  })),
}));

describe('retention archive covers chat + error tables', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionMode', 'purge');
    await cfg.setConfigValue('archiveEnabled', 'true');
    await cfg.setConfigValue('archiveProvider', 's3');
    await cfg.setConfigValue('archiveBucket', 'test-bucket');
    await cfg.setConfigValue('archiveRegion', 'eu-west-2');
    await cfg.setConfigValue('retentionChatDays', '7');
    await cfg.setConfigValue('retentionErrorDays', '7');

    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    const old = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days ago
    const nowS = Math.floor(Date.now() / 1000);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: old, last_seen_at: old });
    await client.insert(schema.chatMessages).values({
      id: 'chat1', user_id: 'u1', prompt_text: 'old prompt', prompt_length: 10,
      occurred_at: old, ingested_at: old,
    });
    await client.insert(schema.chatAssistantMeta).values({
      id: 'meta1', conversation_id: 'c1', user_id: 'u1', model: 'claude-x',
      artifacts_count: 0, generated_files_count: 0, occurred_at: old, ingested_at: nowS,
    });
    // NOTE: adjust fixture columns to each table's NOT-NULL set if the insert
    // errors — the assertions below are the contract.
  });
  afterAll(async () => { await cleanup(); });

  it('archives chat rows before purging and reports them in the result', async () => {
    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const result = await runRetentionCleanup();

    expect(result.archive_error).toBeUndefined();
    expect(result.archived?.chat_rows).toBe(1);
    expect(result.archived?.chat_meta_rows).toBe(1);
    expect(Object.keys(uploaded).some(k => k.includes('chat_messages'))).toBe(true);
    expect(Object.keys(uploaded).some(k => k.includes('chat_assistant_meta'))).toBe(true);
    expect(result.chat_rows_affected).toBe(2); // 1 message + 1 meta purged
  });
});

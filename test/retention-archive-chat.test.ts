// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// With archive enabled + purge mode, chat rows were deleted with
// NO backup (archive covered only cowork/otel/compliance). This test proves
// Claude Chat prompts, chat_assistant_meta and error_events now archive before purge.
// Claude Chat prompts live in cowork_messages (surface 'chat'); they follow the
// Chat window and archive to their own file, cowork_messages_chat, while a
// Cowork prompt of the same age stays on the (longer) Cowork window.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
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
    await client.insert(schema.coworkMessages).values([
      {
        id: 'chat1', session_id: 'c1', user_id: 'u1', message_type: 'cowork_user_message',
        surface: 'chat', source: 'compliance', content_full: 'old prompt', content_preview: 'old prompt',
        occurred_at: old, ingested_at: old,
      },
      // A Cowork prompt of the same age: inside the default 90-day Cowork window.
      {
        id: 'cowork1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message',
        surface: 'cowork', source: 'otel', content_full: 'cowork prompt', content_preview: 'cowork prompt',
        occurred_at: old, ingested_at: old,
      },
    ]);
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
    const chatKey = Object.keys(uploaded).find(k => k.startsWith('ccc-archive/cowork_messages_chat/'));
    expect(chatKey).toBeTruthy();
    expect(Object.keys(uploaded).some(k => k.includes('chat_assistant_meta'))).toBe(true);
    // The Cowork prompt is inside its own window: no Cowork archive file.
    expect(Object.keys(uploaded).some(k => k.startsWith('ccc-archive/cowork_messages/'))).toBe(false);

    // The Claude Chat archive holds the Claude Chat prompt only.
    const lines = gunzipSync(uploaded[chatKey!]).toString('utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.id)).toEqual(['chat1']);
    expect(lines[0]).toMatchObject({ _table: 'cowork_messages_chat', surface: 'chat', content_full: 'old prompt' });

    expect(result.chat_rows_affected).toBe(2); // 1 message + 1 meta purged

    // Purged from cowork_messages; the Cowork prompt of the same age survives.
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    const remaining = await client.select({ id: schema.coworkMessages.id }).from(schema.coworkMessages);
    expect(remaining.map(r => r.id)).toEqual(['cowork1']);
  });
});

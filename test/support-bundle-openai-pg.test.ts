// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT and Codex rows get their own lines in Database health and the
// support bundle, rather than being counted unlabelled inside the Claude
// Cowork and Claude Code totals; the bundle also counts the OpenAI-only tables.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createTestDatabase } from './helpers/db';

/** Reads one file out of a zip buffer via its central directory. */
function readZipEntry(zip: Buffer, name: string): string {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    if (entryName === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf-8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not in zip`);
}

describe('ChatGPT and Codex counted on their own lines', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    const nowS = Math.floor(Date.now() / 1000);
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: nowS, last_seen_at: nowS });
    const msg = (id: string, surface: string, source: string) => ({
      id, session_id: `s-${id}`, user_id: 'u1', message_type: surface === 'code' ? 'code_user_message' : 'cowork_user_message',
      surface, source, occurred_at: nowS - 100, ingested_at: nowS,
    });
    await client.insert(schema.coworkMessages).values([
      msg('code1', 'code', 'otel'),
      msg('cow1', 'cowork', 'otel'),
      msg('cow2', 'cowork', 'otel'),
      msg('g1', 'cowork', 'chatgpt_chat'),
      msg('g2', 'cowork', 'chatgpt_work'),
      msg('g3', 'cowork', 'chatgpt_work'),
      msg('x1', 'code', 'codex'),
    ]);
    await client.insert(schema.openaiReplies).values({ id: 'r1', user_id: 'u1', session_id: 's-g1', source: 'chatgpt_chat', occurred_at: nowS });
    await client.insert(schema.codexTurns).values([
      { id: 't1', user_id: 'u1', session_id: 'codex:1', started_at: nowS },
      { id: 't2', user_id: 'u1', session_id: 'codex:1', started_at: nowS },
    ]);
    await client.insert(schema.codexActions).values({ id: 'a1', user_id: 'u1', session_id: 'codex:1', occurred_at: nowS });
    await client.insert(schema.openaiCosts).values({ id: 'c1', hour_start: nowS, product: 'codex', billed_in: 'usd' });
    await client.insert(schema.chatgptSessionTime).values({ session_id: 'chatgpt:1', user_id: 'u1', source: 'chatgpt_chat', first_at: nowS, last_at: nowS, computed_at: nowS });
  });
  afterAll(async () => cleanup());

  it('Database health: Claude Code and Cowork counts exclude OpenAI rows, which have their own', async () => {
    const { getDbStats } = await import('@/lib/db/queries');
    const s = await getDbStats();
    expect(s.codeCount).toBe(1);
    expect(s.coworkOnlyCount).toBe(2);
    expect(s.chatgptCount).toBe(3);
    expect(s.codexCount).toBe(1);
    expect(s.coworkCount).toBe(7); // combined non-Chat total, unchanged
  });

  it('support bundle: ChatGPT and Codex message lines and the OpenAI-only tables', async () => {
    const { generateSupportBundle } = await import('@/lib/support/bundle');
    const zip = await generateSupportBundle();
    const stats = JSON.parse(readZipEntry(zip, 'db-stats.json')) as { tables: Record<string, number> };
    expect(stats.tables).toMatchObject({
      cowork_messages: 7,
      cowork_messages_chatgpt: 3,
      cowork_messages_codex: 1,
      openai_replies: 1,
      openai_costs: 1,
      chatgpt_session_time: 1,
      codex_turns: 2,
      codex_actions: 1,
    });
  });
});

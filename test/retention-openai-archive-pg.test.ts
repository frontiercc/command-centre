// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Retention for the OpenAI-only tables and for attached file names.
//  1. openai_replies, codex_actions, codex_turns, openai_costs and
//     chatgpt_session_time are archived before they are deleted, on the same
//     cutoffs the cleanup deletes them by (ChatGPT on the Cowork window, Codex
//     on the Code window), in both modes; an archive failure blocks the whole
//     cleanup.
//  2. cowork_sessions.files_uploaded is cleared, in both modes, once the
//     session's last activity is past its window; the row itself stays.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createTestDatabase } from './helpers/db';

const uploaded: Record<string, Buffer> = {};
let failUpload = false;
vi.mock('@/lib/archive/factory', () => ({
  createProvider: vi.fn(async () => ({
    upload: vi.fn(async (key: string, data: Buffer) => {
      if (failUpload) throw new Error('bucket unreachable');
      uploaded[key] = data;
    }),
  })),
}));

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;

function readArchive(prefix: string): Record<string, unknown>[] {
  const key = Object.keys(uploaded).find(k => k.startsWith(`ccc-archive/${prefix}/`));
  if (!key) return [];
  return gunzipSync(uploaded[key]).toString('utf-8').trim().split('\n').map(l => JSON.parse(l));
}

async function seedOpenAi() {
  const { getTypedClient } = await import('@/lib/db/client');
  const { schema } = await import('@/lib/db/schema');
  const client = await getTypedClient();
  // Cowork window 90 days, Code window 30 days (set in beforeEach): a row at
  // 45 days is past the Code window only, at 120 days past both.
  await client.insert(schema.openaiReplies).values([
    { id: 'rep-old', user_id: 'u1', session_id: 'g1', source: 'chatgpt_chat', model: 'gpt-x', occurred_at: daysAgo(120) },
    { id: 'rep-45', user_id: 'u1', session_id: 'g1', source: 'chatgpt_chat', model: 'gpt-x', occurred_at: daysAgo(45) },
  ]);
  await client.insert(schema.codexActions).values([
    { id: 'act-45', user_id: 'u1', session_id: 'x1', tool_name: 'shell', occurred_at: daysAgo(45) },
    { id: 'act-new', user_id: 'u1', session_id: 'x1', tool_name: 'shell', occurred_at: daysAgo(5) },
  ]);
  await client.insert(schema.codexTurns).values([
    { id: 'turn-45', user_id: 'u1', session_id: 'x1', model: 'gpt-codex', started_at: daysAgo(45) },
    { id: 'turn-new', user_id: 'u1', session_id: 'x1', model: 'gpt-codex', started_at: daysAgo(5) },
  ]);
  await client.insert(schema.openaiCosts).values([
    { id: 'cost-chat-old', user_id: 'u1', hour_start: daysAgo(120), product: 'chatgpt', billed_in: 'usd', cost_usd: '1.5' },
    { id: 'cost-chat-45', user_id: 'u1', hour_start: daysAgo(45), product: 'chatgpt', billed_in: 'usd', cost_usd: '1.0' },
    { id: 'cost-codex-45', user_id: 'u1', hour_start: daysAgo(45), product: 'codex', billed_in: 'usd', cost_usd: '2.0' },
  ]);
  await client.insert(schema.chatgptSessionTime).values([
    { session_id: 'g-old', user_id: 'u1', source: 'chatgpt_chat', first_at: daysAgo(130), last_at: daysAgo(120), computed_at: NOW },
    { session_id: 'g-45', user_id: 'u1', source: 'chatgpt_chat', first_at: daysAgo(50), last_at: daysAgo(45), computed_at: NOW },
  ]);
}

async function enableArchive(mode: 'strip' | 'purge') {
  const cfg = await import('@/lib/config');
  await cfg.setConfigValue('retentionMode', mode);
  await cfg.setConfigValue('archiveEnabled', 'true');
  await cfg.setConfigValue('archiveProvider', 's3');
  await cfg.setConfigValue('archiveBucket', 'test-bucket');
  await cfg.setConfigValue('archiveRegion', 'eu-west-2');
}

describe('retention: OpenAI-only tables are archived before they are deleted', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    for (const k of Object.keys(uploaded)) delete uploaded[k];
    failUpload = false;
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionCoworkDays', '90');
    await cfg.setConfigValue('retentionCodeDays', '30');
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: daysAgo(200), last_seen_at: NOW });
    await seedOpenAi();
  });
  afterEach(async () => { await cleanup(); });

  for (const mode of ['purge', 'strip'] as const) {
    it(`${mode} mode: archives each table on its own cutoff, then deletes the same rows`, async () => {
      await enableArchive(mode);
      const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
      const result = await runRetentionCleanup();

      expect(result.archive_error).toBeUndefined();
      // 1 reply + 1 action + 1 turn + 1 ChatGPT cost + 1 Codex cost + 1 session time.
      expect(result.archived?.openai_rows).toBe(6);

      const replies = readArchive('openai_replies');
      expect(replies.map(r => r.id)).toEqual(['rep-old']);
      expect(replies[0]).toMatchObject({ _table: 'openai_replies', occurred_at: daysAgo(120) });

      expect(readArchive('codex_actions').map(r => r.id)).toEqual(['act-45']);

      const turns = readArchive('codex_turns');
      expect(turns.map(r => r.id)).toEqual(['turn-45']);
      // started_at is carried across as the archive's occurred_at.
      expect(turns[0]).toMatchObject({ started_at: daysAgo(45), occurred_at: daysAgo(45) });

      const chatCosts = readArchive('openai_costs');
      expect(chatCosts.map(r => r.id)).toEqual(['cost-chat-old']);
      expect(chatCosts[0]).toMatchObject({ hour_start: daysAgo(120), occurred_at: daysAgo(120) });
      expect(readArchive('openai_costs_codex').map(r => r.id)).toEqual(['cost-codex-45']);

      const times = readArchive('chatgpt_session_time');
      expect(times.map(r => r.session_id)).toEqual(['g-old']);
      expect(times[0]).toMatchObject({ last_at: daysAgo(120), occurred_at: daysAgo(120) });

      // The manifest lists every OpenAI table.
      const manifestKey = Object.keys(uploaded).find(k => k.startsWith('ccc-archive/manifests/'));
      const manifest = JSON.parse(uploaded[manifestKey!].toString('utf-8'));
      for (const t of ['openai_replies', 'codex_actions', 'codex_turns', 'openai_costs', 'openai_costs_codex', 'chatgpt_session_time']) {
        expect(manifest.tables[t]).toMatchObject({ rows: 1 });
      }

      // Exactly the archived rows are gone; the rest stay.
      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const client = await getTypedClient();
      expect((await client.select({ id: schema.openaiReplies.id }).from(schema.openaiReplies)).map(r => r.id)).toEqual(['rep-45']);
      expect((await client.select({ id: schema.codexActions.id }).from(schema.codexActions)).map(r => r.id)).toEqual(['act-new']);
      expect((await client.select({ id: schema.codexTurns.id }).from(schema.codexTurns)).map(r => r.id)).toEqual(['turn-new']);
      expect((await client.select({ id: schema.openaiCosts.id }).from(schema.openaiCosts)).map(r => r.id)).toEqual(['cost-chat-45']);
      expect((await client.select({ id: schema.chatgptSessionTime.session_id }).from(schema.chatgptSessionTime)).map(r => r.id)).toEqual(['g-45']);
    });
  }

  it('an archive failure blocks the cleanup: no OpenAI row is deleted', async () => {
    await enableArchive('purge');
    failUpload = true;
    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const result = await runRetentionCleanup();
    expect(result.archive_error).toContain('bucket unreachable');

    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    expect(await client.select().from(schema.openaiReplies)).toHaveLength(2);
    expect(await client.select().from(schema.codexActions)).toHaveLength(2);
    expect(await client.select().from(schema.codexTurns)).toHaveLength(2);
    expect(await client.select().from(schema.openaiCosts)).toHaveLength(3);
    expect(await client.select().from(schema.chatgptSessionTime)).toHaveLength(2);
  });
});

describe('retention: attached file names are cleared once a session is past its window', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('archiveEnabled', 'false');
    await cfg.setConfigValue('retentionCoworkDays', '90');
    await cfg.setConfigValue('retentionChatDays', '30');
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@x.com', first_seen_at: daysAgo(200), last_seen_at: NOW });
    const files = JSON.stringify(['plan.xlsx', 'notes.docx']);
    await client.insert(schema.coworkSessions).values([
      // Claude Cowork session, last prompt 120 days ago: past the window.
      { id: 's-old', conversation_id: 's-old', user_id: 'u1', source: 'otel', started_at: daysAgo(130), created_at: daysAgo(130), files_uploaded: files },
      // ChatGPT conversation that began 120 days ago but had a prompt 10 days ago: still active.
      { id: 'g-active', conversation_id: 'g-active', user_id: 'u1', source: 'chatgpt_work', started_at: daysAgo(120), created_at: daysAgo(120), files_uploaded: files },
      // ChatGPT conversation whose stats say it ran until 20 days ago: still active.
      { id: 'g-stats', conversation_id: 'g-stats', user_id: 'u1', source: 'chatgpt_chat', started_at: daysAgo(120), created_at: daysAgo(120), files_uploaded: files },
      // ChatGPT conversation entirely 100 days ago: past the window.
      { id: 'g-old', conversation_id: 'g-old', user_id: 'u1', source: 'chatgpt_chat', started_at: daysAgo(100), created_at: daysAgo(100), files_uploaded: files },
      // Claude Chat conversation 45 days ago: past the 30-day Chat window,
      // inside the Cowork window, so it follows the Chat window.
      { id: 'c-45', conversation_id: 'c-45', user_id: 'u1', source: 'compliance', started_at: daysAgo(45), created_at: daysAgo(45), files_uploaded: files },
      // A recent Cowork session.
      { id: 's-new', conversation_id: 's-new', user_id: 'u1', source: 'otel', started_at: daysAgo(3), created_at: daysAgo(3), files_uploaded: files },
    ]);
    await client.insert(schema.coworkMessages).values([
      { id: 'm-old', session_id: 's-old', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', source: 'otel', content_full: 'a', content_preview: 'a', occurred_at: daysAgo(120) },
      { id: 'm-g1', session_id: 'g-active', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_work', content_full: 'b', content_preview: 'b', occurred_at: daysAgo(120) },
      { id: 'm-g2', session_id: 'g-active', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_work', content_full: 'c', content_preview: 'c', occurred_at: daysAgo(10) },
    ]);
    await client.insert(schema.coworkSessionStats).values([
      { session_id: 's-old', user_id: 'u1', first_event_at: daysAgo(130), last_event_at: daysAgo(120), upload_count: 2, computed_at: NOW },
      { session_id: 'g-stats', user_id: 'u1', first_event_at: daysAgo(120), last_event_at: daysAgo(20), upload_count: 2, computed_at: NOW },
    ]);
  });
  afterEach(async () => { await cleanup(); });

  for (const mode of ['strip', 'purge'] as const) {
    it(`${mode} mode: clears names past the window and keeps every session row`, async () => {
      const cfg = await import('@/lib/config');
      await cfg.setConfigValue('retentionMode', mode);
      const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
      const result = await runRetentionCleanup();
      expect(result.session_files_cleared).toBe(3);

      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const client = await getTypedClient();
      const rows = await client.select({ id: schema.coworkSessions.id, files: schema.coworkSessions.files_uploaded }).from(schema.coworkSessions);
      const byId = Object.fromEntries(rows.map(r => [r.id, r.files]));
      expect(Object.keys(byId).sort()).toEqual(['c-45', 'g-active', 'g-old', 'g-stats', 's-new', 's-old']);
      expect(byId['s-old']).toBeNull();
      expect(byId['g-old']).toBeNull();
      expect(byId['c-45']).toBeNull();
      expect(byId['g-active']).not.toBeNull();
      expect(byId['g-stats']).not.toBeNull();
      expect(byId['s-new']).not.toBeNull();

      // The stats row (which hangs off the session) survives.
      const stats = await client.select({ id: schema.coworkSessionStats.session_id }).from(schema.coworkSessionStats);
      expect(stats.map(r => r.id).sort()).toEqual(['g-stats', 's-old']);

      // Files by Category still runs and simply sees fewer files.
      const { getFileCategoryMix } = await import('@/lib/pulse/cowork/file-categories');
      await expect(getFileCategoryMix(200)).resolves.toBeDefined();
    });
  }
});

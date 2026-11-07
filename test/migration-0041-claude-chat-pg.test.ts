// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Migration 0041: every Claude Chat prompt moves from chat_messages into
// cowork_messages (surface 'chat') with its text, flags, person, times and
// source; each conversation gets one cowork_sessions row; chat_messages goes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const MARKER = '[Content removed — retention policy]';

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});
afterAll(async () => cleanup());

describe('migration 0041: Claude Chat prompts move in with Cowork', () => {
  it('moves every prompt, keeps its details, and drops chat_messages', async () => {
    // chat_messages as it stood before 0041 (the migrated test database no longer has it).
    await sql.exec(`CREATE TABLE chat_messages (
      id text PRIMARY KEY, conversation_id text, user_id text REFERENCES users(id),
      prompt_text text NOT NULL, prompt_length integer NOT NULL,
      attachments_count integer DEFAULT 0, files_count integer DEFAULT 0,
      flagged integer DEFAULT 0, flag_reason text, occurred_at bigint NOT NULL,
      ingested_at bigint DEFAULT extract(epoch from now()), agent_id text,
      source text NOT NULL DEFAULT 'agent')`);

    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u1', 'pat@example.org', 'Pat', 'compliance', 1, 1), ('u2', 'sam@example.org', 'Sam', 'agent', 1, 1)`);
    // An existing Cowork prompt whose id a Chat prompt happens to share.
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
      VALUES ('shared-id', 'cowork-sess', 'u1', 'cowork_user_message', 'cowork', 'otel', 'a Cowork prompt', 100)`);

    const long = 'x'.repeat(600);
    const chat = [
      ['m1', 'conv-a', 'u1', 'Summarise the board pack.', 0, null, 1000, 1005, null, 'compliance'],
      ['m2', 'conv-a', 'u1', long, 1, 'PII detected: email', 1100, 1105, null, 'compliance'],
      ['m3', 'conv-b', 'u2', MARKER, 0, null, 900, 905, 'agent-1', 'agent'],
      ['m4', null, 'u2', 'No conversation recorded.', 0, null, 800, 805, 'agent-1', 'agent'],
      ['shared-id', 'conv-c', 'u1', 'Same id as a Cowork prompt.', 0, null, 700, 705, null, 'compliance'],
    ] as const;
    for (const [id, conv, user, text, flagged, reason, at, ingested, agent, source] of chat) {
      await sql.run(`INSERT INTO chat_messages (id, conversation_id, user_id, prompt_text, prompt_length, flagged, flag_reason, occurred_at, ingested_at, agent_id, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, conv, user, text, text.length, flagged, reason, at, ingested, agent, source]);
    }

    const file = path.join(process.cwd(), 'lib/db/migrations-pg/0041_claude_chat_with_cowork.sql');
    await sql.exec(readFileSync(file, 'utf8'));

    const moved = await sql.all<{
      id: string; session_id: string; user_id: string; message_type: string; surface: string; source: string;
      content_preview: string | null; content_full: string | null; flagged: number; flag_reason: string | null;
      occurred_at: number; ingested_at: number; agent_id: string | null;
    }>(`SELECT id, session_id, user_id, message_type, surface, source, content_preview, content_full, flagged, flag_reason, occurred_at, ingested_at, agent_id
          FROM cowork_messages WHERE surface = 'chat' ORDER BY occurred_at`);
    expect(moved).toHaveLength(chat.length);
    const byId = Object.fromEntries(moved.map(r => [r.id, r]));

    expect(byId.m1).toMatchObject({
      session_id: 'conv-a', user_id: 'u1', message_type: 'cowork_user_message', surface: 'chat', source: 'compliance',
      content_preview: 'Summarise the board pack.', content_full: 'Summarise the board pack.', flagged: 0,
      occurred_at: 1000, ingested_at: 1005, agent_id: null,
    });
    // The full text is kept; the preview is the first 250 characters.
    expect(byId.m2.content_full).toBe(long);
    expect(byId.m2.content_preview).toBe(long.slice(0, 250));
    expect(byId.m2).toMatchObject({ flagged: 1, flag_reason: 'PII detected: email' });
    // A retention-stripped prompt keeps the marker as its preview and no full text.
    expect(byId.m3).toMatchObject({ content_preview: MARKER, content_full: null, source: 'agent', agent_id: 'agent-1' });
    expect(byId.m4.session_id).toBe('');
    // The id clash keeps the Chat prompt under a prefixed id; the Cowork prompt is untouched.
    expect(byId['claude-chat:shared-id']).toMatchObject({ content_full: 'Same id as a Cowork prompt.', session_id: 'conv-c' });
    const cowork = await sql.all<{ surface: string; content_full: string }>(`SELECT surface, content_full FROM cowork_messages WHERE id = 'shared-id'`);
    expect(cowork).toEqual([{ surface: 'cowork', content_full: 'a Cowork prompt' }]);

    // One session per conversation, started at its first prompt.
    const sessions = await sql.all<{ id: string; conversation_id: string; user_id: string; source: string; started_at: number }>(
      `SELECT id, conversation_id, user_id, source, started_at FROM cowork_sessions ORDER BY id`);
    expect(sessions).toEqual([
      { id: 'conv-a', conversation_id: 'conv-a', user_id: 'u1', source: 'compliance', started_at: 1000 },
      { id: 'conv-b', conversation_id: 'conv-b', user_id: 'u2', source: 'agent', started_at: 900 },
      { id: 'conv-c', conversation_id: 'conv-c', user_id: 'u1', source: 'compliance', started_at: 700 },
    ]);

    const gone = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'chat_messages'`);
    expect(gone[0].n).toBe(0);
  });
});

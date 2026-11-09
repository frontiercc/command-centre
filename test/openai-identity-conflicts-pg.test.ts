// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OpenAI identity conflicts on Postgres (migration 0048). The OpenAI sync
// resolves people by email; each record also names the OpenAI account
// (actor.user_id). One account arriving under a second, different email is
// recorded as an identity conflict with product 'openai', on the same card
// and with the same Merge / Keep separate / Undo as Claude's. Records go in
// through importOpenAiFiles, the sync's own storing code, with no network.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let sql: import('./helpers/sql').TestSql;
let cleanup: () => Promise<void>;
let sync: typeof import('@/lib/openai/sync');
let conflicts: typeof import('@/lib/otel/identity-conflicts');
let queries: typeof import('@/lib/db/queries');

const ACCOUNT = 'user-AbCdEfGh12345678XYZ';
const A = 'pat@acme.test';
const B = 'pat.new@acme.test';
let seq = 0;

function chat(email: string, account: string | null = ACCOUNT) {
  seq += 1;
  const ts = new Date(Date.now() - 3600_000 + seq * 1000).toISOString();
  return {
    event_id: `evt-${seq}`,
    type: 'CONVERSATION_MESSAGE',
    timestamp: ts,
    actor: { type: 'ACCOUNT_USER', ...(account ? { user_id: account } : {}), user_email: email },
    message: { id: `msg-${seq}`, created_at: ts, author: { type: 'user' }, content: { type: 'text', value: `Draft note ${seq}` } },
    conversation: { id: `conv-${seq}`, mode: 'chat' },
  };
}

function codex(email: string) {
  seq += 1;
  return {
    event_id: `evt-c${seq}`,
    type: 'CODEX_LOG',
    timestamp: new Date(Date.now() - 3600_000 + seq * 1000).toISOString(),
    actor: { type: 'ACCOUNT_USER', user_id: ACCOUNT, user_email: email },
    event_type: 'PROMPT_SENT',
    client_id: 'CODEX_CLI',
    event_details: { session_id: `sess-${seq}`, prompt_text: `Fix test ${seq}` },
  };
}

const userId = async (email: string) =>
  (await sql.all<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower(?)`, [email]))[0]?.id;

describe('OpenAI identity conflicts (postgres)', () => {
  beforeAll(async () => {
    const { createTestDatabase } = await import('./helpers/db');
    const t = await createTestDatabase();
    sql = t.sql; cleanup = t.cleanup;
    sync = await import('@/lib/openai/sync');
    conflicts = await import('@/lib/otel/identity-conflicts');
    queries = await import('@/lib/db/queries');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    for (const t of ['cowork_messages', 'cowork_sessions', 'alerts', 'otel_identity_aliases', 'otel_identity_conflicts', 'openai_identity_users']) {
      await sql.exec(`DELETE FROM ${t}`);
    }
    await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@acme.test'`);
    await sql.exec(`DELETE FROM users WHERE email LIKE '%@acme.test'`);
  });

  it('stores the account against the person it resolved to; the same email again is no conflict', async () => {
    const stats = await sync.importOpenAiFiles([[chat(A), chat(A)], [chat(A.toUpperCase())]]);
    expect(stats.errors).toEqual([]);
    const map = await sql.all<{ openai_user_id: string; user_id: string }>(`SELECT openai_user_id, user_id FROM openai_identity_users`);
    expect(map).toEqual([{ openai_user_id: ACCOUNT, user_id: await userId(A) }]);
    expect(await sql.all(`SELECT * FROM otel_identity_conflicts`)).toEqual([]);
  });

  it('one account under a second email: a separate person, one open conflict with product openai, counted, and a medium alert', async () => {
    await sync.importOpenAiFiles([[chat(A)]]);
    await sync.importOpenAiFiles([[chat(B), chat(B)], [codex(B)]]);

    const a = await userId(A);
    const b = await userId(B);
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
    const rows = await sql.all<Record<string, unknown>>(`SELECT * FROM otel_identity_conflicts`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      installation_id: ACCOUNT, existing_user_id: a, new_email: B, new_user_id: b,
      product: 'openai', surface: 'chatgpt', status: 'open', event_count: 3,
    });
    // B's prompts are stored under B until an admin decides.
    expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages WHERE user_id = ?`, [b]))[0].n).toBe(3);

    const alerts = await sql.all<{ severity: string; title: string; explanation: string; user_id: string }>(
      `SELECT severity, title, explanation, user_id FROM alerts WHERE alert_type = 'identity_conflict'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'medium', user_id: b, title: 'One ChatGPT and Codex account is arriving under two emails' });
    expect(alerts[0].explanation).toContain(A);
    expect(alerts[0].explanation).toContain('ChatGPT activity from an OpenAI account');

    const list = await conflicts.listIdentityConflicts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      product: 'openai', surface: 'chatgpt', existingEmail: A, newEmail: B, installationShort: ACCOUNT.slice(0, 16), eventCount: 3,
    });
  });

  it('merge sends the second email to the existing person going forward; undo sends it back', async () => {
    await sync.importOpenAiFiles([[chat(A)], [chat(B)]]);
    const a = await userId(A);
    const b = await userId(B);
    const id = (await conflicts.listIdentityConflicts())[0].id;

    expect(await conflicts.decideIdentityConflict(id, 'merge', 'admin@acme.test')).toBe('merged');
    await sync.importOpenAiFiles([[chat(B)]]);
    const count = async (u: string | undefined) => (await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages WHERE user_id = ?`, [u]))[0].n;
    expect(await count(a)).toBe(2);
    expect(await count(b)).toBe(1); // history never moves
    expect((await sql.all<{ event_count: number }>(`SELECT event_count FROM otel_identity_conflicts`))[0].event_count).toBe(1);

    expect(await conflicts.decideIdentityConflict(id, 'undo', 'admin@acme.test')).toBe('open');
    await sync.importOpenAiFiles([[chat(B)]]);
    expect(await count(b)).toBe(2);
    expect((await sql.all<{ event_count: number }>(`SELECT event_count FROM otel_identity_conflicts`))[0].event_count).toBe(2);
  });

  it('a record without an OpenAI account id is resolved by email only, as before', async () => {
    await sync.importOpenAiFiles([[chat(A)], [chat(B, null)]]);
    expect(await sql.all(`SELECT * FROM otel_identity_conflicts`)).toEqual([]);
  });

  it('deleteUserData removes the account rows and the conflict naming the person', async () => {
    await sync.importOpenAiFiles([[chat(A)], [chat(B)]]);
    const a = await userId(A);
    await queries.deleteUserData(a!);
    expect(await sql.all(`SELECT * FROM openai_identity_users`)).toEqual([]);
    expect(await sql.all(`SELECT * FROM otel_identity_conflicts`)).toEqual([]);
  });
});

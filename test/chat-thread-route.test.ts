// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/chat/thread. Covers:
//   1. A conversation's user prompts (cowork_messages, surface 'chat') + assistant metadata
//      markers (chat_assistant_meta) are merged and returned in occurred_at
//      ASC order; user rows carry their prompt text, the assistant row
//      carries model + artifacts/generated-files counts and NO prompt text.
//   2. A different conversation's rows never leak into the response, nor do
//      Cowork rows that happen to share the conversation's session id.
//   3. An unknown conversationId returns an empty messages array (not 404/500).
//   4. A retention-stripped row (content_full NULL, only the marker left in
//      content_preview) still returns its row with the marker as its text —
//      the query must not filter on prompt text truthiness.
//   5. Auth: unauthenticated -> 401; missing conversationId param -> 400.
//
// HARNESS RULE (copied from test/compliance-chat-sync.test.ts): schema.ts
// binds getClient() to DATABASE_URL on first use, so the route + schema
// modules are DYNAMIC-imported AFTER createTestDbClient('postgres') has set
// DATABASE_URL + reset modules (the database is fully migrated). vi.mock for admin-auth is declared at the top level
// (hoisted) and survives the later vi.resetModules() call inside the helper.
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';

// A plain mutable closure (not vi.fn().mockResolvedValueOnce) — createTestDbClient()
// calls vi.resetModules() internally, and a fresh dynamic import of a vi.mock'd
// module can rebind vi.fn() instances; reading a closed-over variable each call
// survives that reset (same pattern as test/model-efficiency-route.test.ts).
const STRIPPED = '[Content removed — retention policy]';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null } = {
  authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test',
};
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: async () => sessionResult,
  canAccessAuditLog: (role?: string) => role === 'admin' || role === 'manager',
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: async () => {} }));

/** A Claude Chat prompt row: cowork_messages, surface 'chat', session = conversation. */
function chatPrompt(id: string, conversationId: string, userId: string, text: string | null, occurredAt: number, extra: Record<string, unknown> = {}) {
  return {
    id, session_id: conversationId, user_id: userId,
    message_type: 'cowork_user_message', surface: 'chat', source: 'compliance',
    content_full: text, content_preview: text === null ? null : text.slice(0, 250),
    occurred_at: occurredAt, ...extra,
  };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function setupDb() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // cowork_messages.user_id carries an FK to users on Postgres.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).insert(schema.users).values([
    { id: 'u1', email: 'u1@x.test' },
    { id: 'u2', email: 'u2@x.test' },
  ]);
  return { client, cleanup };
}

describe('GET /api/chat/thread', () => {
  it('merges user prompts + assistant metadata for one conversation, ordered by occurred_at asc', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      await db.insert(schema.coworkMessages).values([
        chatPrompt('m1', 'conv-1', 'u1', 'First prompt', 100),
        chatPrompt('m3', 'conv-1', 'u1', 'Second prompt', 300, { flagged: 1, flag_reason: 'PII detected: email' }),
      ]);
      await db.insert(schema.chatAssistantMeta).values([
        { id: 'm2', conversation_id: 'conv-1', user_id: 'u1', model: 'claude-sonnet-5', artifacts_count: 2, generated_files_count: 1, occurred_at: 200 },
      ]);
      // Different conversation — must never leak into conv-1's thread.
      await db.insert(schema.coworkMessages).values([
        chatPrompt('other', 'conv-2', 'u2', 'Unrelated', 50),
        // A Cowork prompt sharing the session id — not a Claude Chat prompt.
        { ...chatPrompt('cowork-same-id', 'conv-1', 'u1', 'Cowork prompt', 150), surface: 'cowork', source: 'otel' },
      ]);

      const { GET } = await import('@/app/api/chat/thread/route');
      const res = await GET(makeRequest('/api/chat/thread?conversationId=conv-1'));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.messages).toHaveLength(3);
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2', 'm3']);

      expect(body.messages[0]).toMatchObject({
        id: 'm1', role: 'user', content: 'First prompt', occurred_at: 100, flagged: 0,
      });

      // Assistant row: model + counts present, no prompt text of either user turn.
      expect(body.messages[1]).toMatchObject({
        id: 'm2', role: 'assistant', model: 'claude-sonnet-5',
        artifacts_count: 2, generated_files_count: 1, occurred_at: 200,
      });
      expect(body.messages[1].content).not.toMatch(/First prompt|Second prompt/);

      expect(body.messages[2]).toMatchObject({
        id: 'm3', role: 'user', content: 'Second prompt', flagged: 1, flag_reason: 'PII detected: email',
      });
    } finally {
      await cleanup();
    }
  });

  it('returns empty messages for an unknown conversationId', async () => {
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/chat/thread/route');
      const res = await GET(makeRequest('/api/chat/thread?conversationId=does-not-exist'));
      expect(res.status).toBe(200);
      expect((await res.json()).messages).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('still returns a row whose prompt text was stripped by retention', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      // Retention strip mode: content_full NULL, the marker left in content_preview.
      await db.insert(schema.coworkMessages).values([
        { ...chatPrompt('stripped', 'conv-3', 'u1', null, 100), content_preview: STRIPPED },
      ]);

      const { GET } = await import('@/app/api/chat/thread/route');
      const res = await GET(makeRequest('/api/chat/thread?conversationId=conv-3'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ id: 'stripped', role: 'user', content: STRIPPED });
    } finally {
      await cleanup();
    }
  });

  it('returns 400 when conversationId is missing', async () => {
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/chat/thread/route');
      const res = await GET(makeRequest('/api/chat/thread'));
      expect(res.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  it('returns 401 when unauthenticated', async () => {
    sessionResult = { authenticated: false };
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/chat/thread/route');
      const res = await GET(makeRequest('/api/chat/thread?conversationId=conv-1'));
      expect(res.status).toBe(401);
    } finally {
      sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
      await cleanup();
    }
  });
  it('refuses viewers and contributor roles (pulse/cowork/code) with 403', async () => {
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/chat/thread/route');
      for (const role of ['viewer', 'pulse', 'cowork', 'code']) {
        sessionResult = { authenticated: true, role, userId: 'p1', email: 'p@x.test', department: 'Finance' };
        const res = await GET(makeRequest('/api/chat/thread?conversationId=conv-1'));
        expect(res.status).toBe(403);
      }
    } finally {
      sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
      await cleanup();
    }
  });

  it('a department-scoped manager sees only their own department rows', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      await db.insert(schema.users).values([
        { id: 'fin', department: 'Finance' },
        { id: 'ops', department: 'Operations' },
        { id: 'linked', department: null },
      ]);
      // admin_users.department wins over users.department
      await db.insert(schema.adminUsers).values({
        id: 'au1', email: 'au1@x.test', password_hash: 'x', linked_cowork_user_id: 'linked', department: 'Finance',
      });
      await db.insert(schema.coworkMessages).values([
        chatPrompt('f1', 'c', 'fin', 'fin', 1),
        chatPrompt('o1', 'c', 'ops', 'ops', 2),
        chatPrompt('l1', 'c', 'linked', 'linked', 3),
      ]);
      await db.insert(schema.chatAssistantMeta).values([
        { id: 'oa', conversation_id: 'c', user_id: 'ops', model: 'm', occurred_at: 4 },
      ]);
      const { GET } = await import('@/app/api/chat/thread/route');

      sessionResult = { authenticated: true, role: 'manager', userId: 'v1', email: 'v@x.test', department: 'Finance' };
      let body = await (await GET(makeRequest('/api/chat/thread?conversationId=c'))).json();
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['f1', 'l1']);

      // A manager with no department is refused; an admin sees everything.
      sessionResult = { authenticated: true, role: 'manager', userId: 'v2', email: 'v2@x.test', department: null };
      const refused = await GET(makeRequest('/api/chat/thread?conversationId=c'));
      expect(refused.status).toBe(403);
      expect((await refused.json()).error).toBe('no_department');
      sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test', department: 'Operations' };
      body = await (await GET(makeRequest('/api/chat/thread?conversationId=c'))).json();
      expect(body.messages).toHaveLength(4);
    } finally {
      sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
      await cleanup();
    }
  });
});

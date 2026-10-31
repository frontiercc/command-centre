// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/events chat provenance — the badge (`_source`) is READ FROM THE
// STORED `source` COLUMN, never assumed from the surface (the product rule,
// The app stamps the door each row arrived through, so the
// display reads the stamp). A Compliance-synced row badges Compliance API; a
// legacy-agent or seed row (source='agent') badges the agent. This replaces
// the July "chat is strictly Compliance API by surface" display rule, which
// was a correct guess for real data but a guess. Covers:
//   1. source='compliance' -> `_source: 'compliance'`; source='agent' ->
//      `_source: 'local-agent'` — per row, from the column.
//   2. The ?source= filter filters on the same column.
//   3. Claude Chat prompts live in cowork_messages (surface 'chat'), yet the
//      unfiltered listing shows each one exactly once, as a chat_prompt on
//      the chat surface, never a second time as a Cowork message.
//
// HARNESS RULE (copied from test/chat-thread-route.test.ts): schema.ts
// binds getClient() to DATABASE_URL on first use, so the route + schema
// modules are DYNAMIC-imported AFTER createTestDbClient('postgres') has set
// DATABASE_URL + reset modules (the database is fully migrated). vi.mock for admin-auth/audit-log is declared at the
// top level (hoisted) and survives the later vi.resetModules() call inside
// the helper.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string } = {
  authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test',
};
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => sessionResult,
  };
});
vi.mock('@/lib/audit/log', () => ({
  logAccess: vi.fn(),
}));

/** A Claude Chat prompt row: cowork_messages, surface 'chat', session = conversation. */
function chatPrompt(id: string, conversationId: string, text: string, occurredAt: number, agentId: string | null, source: string) {
  return {
    id, session_id: conversationId, user_id: 'u1',
    message_type: 'cowork_user_message', surface: 'chat', source,
    content_full: text, content_preview: text.slice(0, 250),
    occurred_at: occurredAt, agent_id: agentId,
  };
}

const CHAT_ROWS = [
  // Legacy Desktop-agent row (source='agent') — badges the agent.
  chatPrompt('agent-1', 'conv-agent', 'from the agent', 100, 'agent-xyz', 'agent'),
  // Real Compliance-synced row.
  chatPrompt('compliance-1', 'claude_chat_1', 'from compliance', 200, null, 'compliance'),
  // Synthetic seed row (source='agent' default) with no conversation — badges the agent too.
  chatPrompt('seed-1', '', '[seed] daily activity', 300, null, 'agent'),
];

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function setupDb() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // cowork_messages.user_id carries an FK to users on Postgres.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).insert(schema.users).values({ id: 'u1', email: 'u1@x.test' });
  return { client, cleanup };
}

describe('GET /api/events chat provenance (badge read from the stored source column)', () => {
  it('every chat row maps to _source=\'compliance\' regardless of stored source (strict rule)', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      await db.insert(schema.coworkMessages).values(CHAT_ROWS);

      const { GET } = await import('@/app/api/events/route');
      const res = await GET(makeRequest('/api/events?source=chat'));
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ id: string; _source: string; event_type: string; surface: string; content_preview: string }>;

      // All three chat rows returned; each badges its OWN stored source.
      expect(body.map(r => r.id).sort()).toEqual(['agent-1', 'compliance-1', 'seed-1']);
      for (const r of body) {
        expect(r.event_type).toBe('chat_prompt');
        expect(r.surface).toBe('chat');
      }
      expect(body.find(r => r.id === 'compliance-1')?.content_preview).toBe('from compliance');
      const byId = Object.fromEntries(body.map(r => [r.id, r._source]));
      expect(byId['compliance-1']).toBe('compliance');
      expect(byId['agent-1']).toBe('local-agent');
      expect(byId['seed-1']).toBe('local-agent');
    } finally {
      await cleanup();
    }
  });

  it('?source=compliance returns only source=\'compliance\' rows, mapped to _source=\'compliance\', and never the synthetic seed row', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      await db.insert(schema.coworkMessages).values(CHAT_ROWS);

      const { GET } = await import('@/app/api/events/route');
      const res = await GET(makeRequest('/api/events?source=compliance'));
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ id: string; _source: string }>;

      expect(body.map(r => r.id)).toEqual(['compliance-1']);
      expect(body[0]._source).toBe('compliance');
    } finally {
      await cleanup();
    }
  });

  it('the unfiltered listing shows each Claude Chat prompt once, as chat_prompt, beside Cowork rows', async () => {
    const { client, cleanup } = await setupDb();
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;

      await db.insert(schema.coworkMessages).values([
        ...CHAT_ROWS,
        {
          id: 'cowork-1', session_id: 'sess-cowork', user_id: 'u1',
          message_type: 'cowork_user_message', surface: 'cowork', source: 'otel',
          content_full: 'a cowork prompt', content_preview: 'a cowork prompt', occurred_at: 400,
        },
      ]);

      const { GET } = await import('@/app/api/events/route');
      const res = await GET(makeRequest('/api/events'));
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ id: string; event_type: string; surface: string }>;

      // Each id exactly once: the Cowork reader leaves surface 'chat' to the chat reader.
      expect(body.map(r => r.id).sort()).toEqual(['agent-1', 'compliance-1', 'cowork-1', 'seed-1']);
      const byId = Object.fromEntries(body.map(r => [r.id, r]));
      for (const id of ['agent-1', 'compliance-1', 'seed-1']) {
        expect(byId[id]).toMatchObject({ event_type: 'chat_prompt', surface: 'chat' });
      }
      expect(byId['cowork-1']).toMatchObject({ event_type: 'cowork_user_message', surface: 'cowork' });
    } finally {
      await cleanup();
    }
  });
});

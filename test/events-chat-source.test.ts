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

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function setupDb() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // chat_messages.user_id carries an FK to users on Postgres.
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

      await db.insert(schema.chatMessages).values([
        // Legacy Desktop-agent row (source='agent') — badges the agent.
        { id: 'agent-1', conversation_id: 'conv-agent', user_id: 'u1', prompt_text: 'from the agent', prompt_length: 14, occurred_at: 100, agent_id: 'agent-xyz', source: 'agent' },
        // Real Compliance-synced row.
        { id: 'compliance-1', conversation_id: 'claude_chat_1', user_id: 'u1', prompt_text: 'from compliance', prompt_length: 16, occurred_at: 200, agent_id: null, source: 'compliance' },
        // Synthetic seed row (source='agent' default) — badges the agent too.
        { id: 'seed-1', conversation_id: null, user_id: 'u1', prompt_text: '[seed] daily activity', prompt_length: 22, occurred_at: 300, agent_id: null, source: 'agent' },
      ]);

      const { GET } = await import('@/app/api/events/route');
      const res = await GET(makeRequest('/api/events?source=chat'));
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ id: string; _source: string }>;

      // All three chat rows returned; each badges its OWN stored source.
      expect(body.map(r => r.id).sort()).toEqual(['agent-1', 'compliance-1', 'seed-1']);
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

      await db.insert(schema.chatMessages).values([
        { id: 'agent-1', conversation_id: 'conv-agent', user_id: 'u1', prompt_text: 'from the agent', prompt_length: 14, occurred_at: 100, agent_id: 'agent-xyz', source: 'agent' },
        { id: 'compliance-1', conversation_id: 'claude_chat_1', user_id: 'u1', prompt_text: 'from compliance', prompt_length: 16, occurred_at: 200, agent_id: null, source: 'compliance' },
        { id: 'seed-1', conversation_id: null, user_id: 'u1', prompt_text: '[seed] daily activity', prompt_length: 22, occurred_at: 300, agent_id: null, source: 'agent' },
      ]);

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
});

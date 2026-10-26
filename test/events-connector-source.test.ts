// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/events — skill/connector invocation rows badge WHERE THEY CAME
// FROM (the product rule): the row's own `source` column, not a value
// inferred from the surface. Until this fix every cowork_mcp_invocations /
// cowork_skill_invocations row was hardcoded `_source: 'otel'`, so the chat
// connectors the Compliance API sync writes (source='compliance') showed an
// "OTel" badge on the Azure sandbox's first real sync. Covers:
//   1. A compliance-sourced connector row maps to `_source: 'compliance'`;
//      OTel-sourced connector + skill rows map to `_source: 'otel'`.
//   2. ?source=compliance returns the compliance connector row (alongside
//      chat events) and NOT the OTel rows; ?source=otel the reverse.
//
// HARNESS RULE (copied from test/events-chat-source.test.ts): schema.ts
// binds getClient() to DATABASE_URL on first use, so the route + schema
// modules are DYNAMIC-imported AFTER createTestDbClient('postgres') has set
// DATABASE_URL + reset modules (the database is fully migrated).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => sessionResult };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

async function setupDb() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  await db.insert(schema.users).values({ id: 'u1', email: 'u1@x.test', display_name: 'User One' });
  await db.insert(schema.coworkMcpInvocations).values([
    // Written by the Compliance API chat sync — a real connector on the chat surface.
    { id: 'mcp-compliance', user_id: 'u1', session_id: 'chat-1', mcp_server: 'linear', mcp_tool: 'create_issue', occurred_at: 300, source: 'compliance', surface: 'chat' },
    // Written by the OTel cowork receiver.
    { id: 'mcp-otel', user_id: 'u1', session_id: 'sess-1', mcp_server: 'salesforce', mcp_tool: 'soql', occurred_at: 200, source: 'otel', surface: 'cowork' },
  ]);
  await db.insert(schema.coworkSkillInvocations).values([
    { id: 'skill-otel', user_id: 'u1', session_id: 'sess-1', skill_name: 'docx', occurred_at: 100, source: 'otel', surface: 'cowork' },
  ]);
  return { cleanup };
}

type Row = { id: string; _source: string; event_type: string };

describe('GET /api/events connector/skill provenance (row source column drives the badge)', () => {
  it('badges each invocation row by its own source: compliance -> Compliance API, otel -> OTel', async () => {
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/events/route');
      // ?surface=cowork and ?source=compliance between them return every row
      // inserted above; the badge assertion is per row regardless of route.
      const otelRes = await GET(makeRequest('/api/events?source=otel'));
      const compRes = await GET(makeRequest('/api/events?source=compliance'));
      expect(otelRes.status).toBe(200);
      expect(compRes.status).toBe(200);
      const rows = [...(await otelRes.json() as Row[]), ...(await compRes.json() as Row[])];
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));

      expect(byId['mcp-compliance']?._source).toBe('compliance');
      expect(byId['mcp-compliance']?.event_type).toBe('cowork_mcp_event');
      expect(byId['mcp-otel']?._source).toBe('otel');
      expect(byId['skill-otel']?._source).toBe('otel');
    } finally {
      await cleanup();
    }
  });

  it('?source=compliance includes compliance connector rows and excludes OTel ones; ?source=otel the reverse', async () => {
    const { cleanup } = await setupDb();
    try {
      const { GET } = await import('@/app/api/events/route');

      const comp = await (await GET(makeRequest('/api/events?source=compliance'))).json() as Row[];
      expect(comp.map(r => r.id)).toEqual(['mcp-compliance']);

      const otel = await (await GET(makeRequest('/api/events?source=otel'))).json() as Row[];
      expect(otel.map(r => r.id).sort()).toEqual(['mcp-otel', 'skill-otel']);
    } finally {
      await cleanup();
    }
  });
});

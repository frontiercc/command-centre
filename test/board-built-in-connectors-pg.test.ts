// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude's own connectors (internal servers such as ccd_session or visualize, and
// Claude in Chrome and Claude Preview) are never listed on the S&C Board or counted
// in it, whatever their spelling, and ingest never gives them a board entry.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { isBoardHiddenConnector } from '@/lib/library/built-in-connectors';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin-1', department: null }),
  };
});

const NOW = Math.floor(Date.now() / 1000);
let cleanup: () => Promise<void>;

describe('isBoardHiddenConnector', () => {
  it("knows Claude's own connectors in any spelling, and not real ones", () => {
    for (const n of ['ccd_session', 'CCD Session', 'visualize', 'Claude_Preview', 'claude preview', 'Claude_in_Chrome', 'workspace']) {
      expect(isBoardHiddenConnector(n)).toBe(true);
    }
    for (const n of ['Slack', 'Google Drive', 'jira', 'salesforce']) expect(isBoardHiddenConnector(n)).toBe(false);
  });
});

describe('S&C Board', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const h = await createTestDbClient('postgres');
    cleanup = h.cleanup;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = h.client;
    const { schema } = await import('@/lib/db/schema');
    await client.insert(schema.users).values({ id: 'u1', email: 'u1@corp.com', display_name: 'Ada', department: 'Sales' });
    await client.insert(schema.skillLibraryEntries).values([
      { name: 'jira', type: 'connector', surface: 'cowork', source: 'org', is_published: 0, created_at: NOW, updated_at: NOW },
      { name: 'visualize', type: 'connector', surface: 'cowork', source: 'org', is_published: 0, created_at: NOW, updated_at: NOW },
      { name: 'Claude_Preview', type: 'connector', surface: 'cowork', source: 'org', is_published: 0, created_at: NOW, updated_at: NOW },
    ]);
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'i1', user_id: 'u1', session_id: 's1', mcp_server: 'jira', mcp_tool: 'search', occurred_at: NOW - 3600, source: 'otel', surface: 'cowork', success: 1 },
      { id: 'i2', user_id: 'u1', session_id: 's1', mcp_server: 'visualize', mcp_tool: 'show', occurred_at: NOW - 3600, source: 'otel', surface: 'cowork', success: 1 },
    ]);
  }, 120_000);
  afterAll(async () => cleanup?.());

  it('lists and counts only real connectors', async () => {
    const { GET } = await import('../app/api/library/route');
    const body = await (await GET(new NextRequest('http://localhost/api/library?type=connector'))).json();
    const names = (body.entries as Array<{ name: string }>).map(e => e.name);
    expect(names).toContain('jira');
    expect(names).not.toContain('visualize');
    expect(names).not.toContain('Claude_Preview');
    expect(body.stats.connector_count).toBe(1);
    expect(body.unclaimed_count).toBe(1);
  });
});

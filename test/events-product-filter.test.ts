// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/events — the Audit Log's Product filter (?product=) and its
// "how it arrived" Source filter (?source=otel|compliance|openai: OpenTelemetry,
// Anthropic's Compliance API alone, and OpenAI's Compliance API). ChatGPT
// prompts are stored beside Claude Cowork prompts and Codex beside Claude
// Code, so each product must be told apart by its source, never by surface
// alone. Same harness as test/events-connector-source.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => sessionResult };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function prompt(id: string, surface: string, source: string, occurredAt: number) {
  return {
    id, session_id: `s-${id}`, user_id: 'u1', message_type: 'cowork_user_message', surface, source,
    content_full: `text ${id}`, content_preview: `text ${id}`, occurred_at: occurredAt,
  };
}

async function setupDb() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const { schema } = await import('@/lib/db/schema');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  await db.insert(schema.users).values({ id: 'u1', email: 'u1@x.test', display_name: 'User One' });
  await db.insert(schema.coworkMessages).values([
    prompt('claude-chat', 'chat', 'compliance', 100),
    prompt('claude-cowork', 'cowork', 'otel', 200),
    prompt('claude-code', 'code', 'otel', 300),
    prompt('chatgpt-chat', 'cowork', 'chatgpt_chat', 400),
    prompt('chatgpt-work', 'cowork', 'chatgpt_work', 500),
    prompt('codex', 'code', 'codex', 600),
  ]);
  await db.insert(schema.coworkMcpInvocations).values([
    { id: 'mcp-claude', user_id: 'u1', session_id: 's-claude-cowork', mcp_server: 'salesforce', mcp_tool: 'soql', occurred_at: 210, source: 'otel', surface: 'cowork' },
    { id: 'mcp-chatgpt', user_id: 'u1', session_id: 's-chatgpt-work', mcp_server: 'notion', mcp_tool: 'search', occurred_at: 510, source: 'chatgpt_work', surface: 'cowork' },
    // A Claude Chat connector synced by Anthropic's Compliance API.
    { id: 'mcp-claude-chat', user_id: 'u1', session_id: 's-claude-chat', mcp_server: 'google-drive', mcp_tool: 'search', occurred_at: 110, source: 'compliance', surface: 'chat' },
    // Stamped 'agent', the column default (the retired agent, older seed data): shown under All sources only.
    { id: 'mcp-unstamped', user_id: 'u1', session_id: 's-claude-cowork', mcp_server: 'jira', mcp_tool: 'search', occurred_at: 220, source: 'agent', surface: 'cowork' },
  ]);
  return { cleanup };
}

async function ids(url: string): Promise<string[]> {
  const { GET } = await import('@/app/api/events/route');
  const res = await GET(new NextRequest(`http://localhost${url}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }[]).map(r => r.id).sort();
}

describe('GET /api/events product and arrival filters', () => {
  it('returns each product on its own, keeping ChatGPT apart from Claude Cowork and Codex apart from Claude Code', async () => {
    const { cleanup } = await setupDb();
    try {
      expect(await ids('/api/events?product=claude_chat')).toEqual(['claude-chat', 'mcp-claude-chat']);
      expect(await ids('/api/events?product=claude_cowork')).toEqual(['claude-cowork', 'mcp-claude', 'mcp-unstamped']);
      expect(await ids('/api/events?product=claude_code')).toEqual(['claude-code']);
      expect(await ids('/api/events?product=chatgpt_chat')).toEqual(['chatgpt-chat']);
      expect(await ids('/api/events?product=chatgpt_work')).toEqual(['chatgpt-work', 'mcp-chatgpt']);
      expect(await ids('/api/events?product=codex')).toEqual(['codex']);
      // The Product list's "Cowork" (?app=cowork) is Claude's Cowork alone, never ChatGPT Work.
      expect(await ids('/api/events?app=cowork')).toEqual(['claude-cowork']);
    } finally {
      await cleanup();
    }
  });

  it('shows agent-stamped rows under All sources only', async () => {
    const { cleanup } = await setupDb();
    try {
      expect(await ids('/api/events')).toContain('mcp-unstamped');
    } finally {
      await cleanup();
    }
  });

  it('filters by how the rows arrived, alone or with a product', async () => {
    const { cleanup } = await setupDb();
    try {
      expect(await ids('/api/events?source=openai')).toEqual(['chatgpt-chat', 'chatgpt-work', 'codex', 'mcp-chatgpt']);
      expect(await ids('/api/events?source=otel')).toEqual(['claude-code', 'claude-cowork', 'mcp-claude']);
      // Anthropic's Compliance API alone: never a ChatGPT or Codex row.
      expect(await ids('/api/events?source=compliance')).toEqual(['claude-chat', 'mcp-claude-chat']);
      expect(await ids('/api/events?product=claude_chat&source=compliance')).toEqual(['claude-chat', 'mcp-claude-chat']);
      expect(await ids('/api/events?product=chatgpt_chat&source=compliance')).toEqual([]);
      expect(await ids('/api/events?product=codex&source=openai')).toEqual(['codex']);
      expect(await ids('/api/events?product=claude_code&source=openai')).toEqual([]);
      expect(await ids('/api/events?product=claude_chat&source=otel')).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

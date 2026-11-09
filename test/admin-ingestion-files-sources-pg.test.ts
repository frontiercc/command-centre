// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Admin → Ingestion's Recent users (where each person was first seen) and
// Admin → File Uploads (the product each file was attached in), across
// Claude's telemetry, Anthropic's Compliance API and OpenAI's Compliance API.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { firstSeenLabel } from '@/lib/sources/first-seen';
import { fileProductLabel, fileProductOf } from '@/lib/sources/file-product';

const session = { authenticated: true, role: 'admin', email: 'admin@test.local', userId: 'admin1' };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => session, requireAdmin: async () => session };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
let cleanup: () => Promise<void>;

function req(url: string) {
  return new NextRequest(`http://localhost${url}`);
}

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  const { schema } = await import('@/lib/db/schema');
  const { getClient } = await import('@/lib/db/client');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (await getClient()) as any;
  const user = (id: string, source: string, lastSeen: number) => ({
    id, email: `${id}@test.local`, display_name: id, source, first_seen_at: NOW - 10 * DAY, last_seen_at: lastSeen,
  });
  await db.insert(schema.users).values([
    user('code-person', 'otel', NOW - 1),
    user('excel-person', 'otel', NOW - 2),
    user('quiet-otel', 'otel', NOW - 3),
    user('chat-person', 'compliance', NOW - 4),
    user('quiet-compliance', 'compliance', NOW - 5),
    user('codex-person', 'openai', NOW - 6),
    user('quiet-openai', 'openai', NOW - 7),
    user('agent-person', 'agent', NOW),
  ]);
  const prompt = (id: string, userId: string, at: number, extra: Record<string, unknown>) => ({
    id, session_id: `s-${id}`, user_id: userId, content_preview: id, occurred_at: at, ...extra,
  });
  await db.insert(schema.coworkMessages).values([
    // The earliest prompt decides: Claude Code first, Cowork later.
    prompt('p1', 'code-person', NOW - 5 * DAY, { message_type: 'code_user_message', surface: 'code', source: 'otel' }),
    prompt('p2', 'code-person', NOW - 1 * DAY, { message_type: 'cowork_user_message', surface: 'cowork', source: 'otel' }),
    // An earlier tool row is not a prompt and does not count.
    prompt('t1', 'excel-person', NOW - 9 * DAY, { message_type: 'cowork_tool_metadata', surface: 'cowork', source: 'otel' }),
    prompt('p3', 'excel-person', NOW - 4 * DAY, { message_type: 'cowork_user_message', surface: 'cowork', source: 'otel', product: 'excel' }),
    prompt('p4', 'chat-person', NOW - 3 * DAY, { message_type: 'cowork_user_message', surface: 'chat', source: 'compliance' }),
    prompt('p5', 'codex-person', NOW - 3 * DAY, { message_type: 'code_user_message', surface: 'code', source: 'codex' }),
    prompt('p6', 'codex-person', NOW - 2 * DAY, { message_type: 'cowork_user_message', surface: 'cowork', source: 'chatgpt_work' }),
  ]);
  await db.insert(schema.coworkSessions).values([
    { id: 'cs-cowork', conversation_id: 'cs-cowork', user_id: 'code-person', source: 'otel', started_at: NOW - DAY, files_uploaded: JSON.stringify(['plan.docx']) },
    { id: 'cs-agent', conversation_id: 'cs-agent', user_id: 'code-person', started_at: NOW - DAY, files_uploaded: JSON.stringify(['old.txt']) },
    { id: 'cs-chat', conversation_id: 'cs-chat', user_id: 'chat-person', source: 'compliance', started_at: NOW - DAY, files_uploaded: JSON.stringify(['brief.pdf']) },
    { id: 'chatgpt:c1', conversation_id: 'chatgpt:c1', user_id: 'codex-person', source: 'chatgpt_chat', started_at: NOW - DAY, files_uploaded: JSON.stringify(['budget.xlsx']) },
    { id: 'chatgpt:w1', conversation_id: 'chatgpt:w1', user_id: 'codex-person', source: 'chatgpt_work', started_at: NOW - DAY, files_uploaded: JSON.stringify(['deck.pptx']) },
  ]);
});

afterAll(async () => cleanup());

describe('firstSeenLabel', () => {
  it('names the product, an Office or Google app on its own, else the arrival route', () => {
    expect(firstSeenLabel('claude_code', null, 'otel')).toBe('Claude Code');
    expect(firstSeenLabel('claude_cowork', null, 'otel')).toBe('Claude Cowork');
    expect(firstSeenLabel('claude_cowork', 'excel', 'otel')).toBe('Claude in Excel');
    expect(firstSeenLabel('claude_cowork', 'sheets', 'otel')).toBe('Claude in Google Sheets');
    expect(firstSeenLabel('claude_chat', null, 'compliance')).toBe('Claude Chat');
    expect(firstSeenLabel('chatgpt_chat', null, 'openai')).toBe('ChatGPT Chat');
    expect(firstSeenLabel('chatgpt_work', null, 'openai')).toBe('ChatGPT Work');
    expect(firstSeenLabel('codex', null, 'openai')).toBe('Codex');
    expect(firstSeenLabel(null, null, 'otel')).toBe('Claude telemetry');
    expect(firstSeenLabel(null, null, 'compliance')).toBe('Anthropic Compliance API');
    expect(firstSeenLabel(null, null, 'openai')).toBe('OpenAI Compliance API');
  });
});

describe('GET /api/admin/otel-status recent users (postgres)', () => {
  it('lists people from all three routes, each with the product of their earliest prompt', async () => {
    const { GET } = await import('../app/api/admin/otel-status/route');
    const res = await GET(req('/api/admin/otel-status'));
    expect(res.status).toBe(200);
    const body = await res.json() as { recentOtelUsers: Array<{ id: string; first_seen_in: string; last_seen_at: number }> };
    expect(body.recentOtelUsers.map(u => [u.id, u.first_seen_in])).toEqual([
      ['code-person', 'Claude Code'],
      ['excel-person', 'Claude in Excel'],
      ['quiet-otel', 'Claude telemetry'],
      ['chat-person', 'Claude Chat'],
      ['quiet-compliance', 'Anthropic Compliance API'],
      ['codex-person', 'Codex'],
      ['quiet-openai', 'OpenAI Compliance API'],
    ]);
    expect(typeof body.recentOtelUsers[0].last_seen_at).toBe('number');
  });
});

describe('fileProductLabel', () => {
  it('reads the product from the session source, naming an Office app on its own', () => {
    expect(fileProductLabel(fileProductOf('chatgpt_chat'), null)).toBe('ChatGPT Chat');
    expect(fileProductLabel(fileProductOf('chatgpt_work'), null)).toBe('ChatGPT Work');
    expect(fileProductLabel(fileProductOf('compliance'), null)).toBe('Claude Chat');
    expect(fileProductLabel(fileProductOf('otel'), null)).toBe('Claude Cowork');
    expect(fileProductLabel(fileProductOf('agent'), null)).toBe('Claude Cowork');
    expect(fileProductLabel(fileProductOf('otel'), 'word')).toBe('Claude in Word');
  });
});

describe('GET /api/admin/files products (postgres)', () => {
  it('returns each file with its product and lists the products with files', async () => {
    const { GET } = await import('../app/api/admin/files/route');
    const res = await GET(req('/api/admin/files'));
    expect(res.status).toBe(200);
    const body = await res.json() as { files: Array<{ filename: string; product: string; product_label: string }>; products: Array<{ id: string; label: string }> };
    expect(Object.fromEntries(body.files.map(f => [f.filename, f.product_label]))).toEqual({
      'plan.docx': 'Claude Cowork',
      'old.txt': 'Claude Cowork',
      'brief.pdf': 'Claude Chat',
      'budget.xlsx': 'ChatGPT Chat',
      'deck.pptx': 'ChatGPT Work',
    });
    expect(body.products).toEqual([
      { id: 'claude_cowork', label: 'Claude Cowork' },
      { id: 'claude_chat', label: 'Claude Chat' },
      { id: 'chatgpt_chat', label: 'ChatGPT Chat' },
      { id: 'chatgpt_work', label: 'ChatGPT Work' },
    ]);
  });

  it('filters by product, and ignores an unknown one', async () => {
    const { GET } = await import('../app/api/admin/files/route');
    const names = async (q: string) => ((await (await GET(req(`/api/admin/files${q}`))).json()) as { files: Array<{ filename: string }> })
      .files.map(f => f.filename).sort();
    expect(await names('?product=chatgpt_work')).toEqual(['deck.pptx']);
    expect(await names('?product=chatgpt_chat')).toEqual(['budget.xlsx']);
    expect(await names('?product=claude_chat')).toEqual(['brief.pdf']);
    expect(await names('?product=claude_cowork')).toEqual(['old.txt', 'plan.docx']);
    expect(await names('?product=nonsense')).toHaveLength(5);
  });

  it('lists ChatGPT files even while ChatGPT and Codex are hidden', async () => {
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('openaiShown', 'false');
    try {
      const { GET } = await import('../app/api/admin/files/route');
      const body = await (await GET(req('/api/admin/files?product=chatgpt_chat'))).json() as { files: Array<{ filename: string }> };
      expect(body.files.map(f => f.filename)).toEqual(['budget.xlsx']);
    } finally {
      await setConfigValue('openaiShown', 'true');
    }
  });
});

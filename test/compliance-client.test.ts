// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// test/compliance-client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listChats, getChatMessages, listActivities, retryAfterSeconds, ComplianceApiError, type ComplianceToolUseBlock } from '@/lib/compliance/client';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('compliance client', () => {
  it('listChats pins order_by=updated_at and passes updated_at.gte on first run', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await listChats('k', { updatedAtGte: '2026-06-21T00:00:00Z' });
    expect(capturedUrl).toContain('/v1/compliance/apps/chats');
    expect(capturedUrl).toContain('order_by=updated_at');
    expect(capturedUrl).toContain('updated_at.gte=2026-06-21');
    expect(capturedUrl).not.toContain('after_id');
  });

  it('listChats passes after_id (and no gte bound) when a cursor exists', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await listChats('k', { afterId: 'cursor-abc' });
    expect(capturedUrl).toContain('after_id=cursor-abc');
    expect(capturedUrl).not.toContain('updated_at.gte');
  });

  it('getChatMessages always sends an explicit limit', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ chat_messages: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await getChatMessages('k', 'claude_chat_1', {});
    expect(capturedUrl).toContain('/v1/compliance/apps/chats/claude_chat_1/messages');
    expect(capturedUrl).toContain('limit=100');
  });

  it('throws typed ComplianceApiError on 401 without retrying', async () => {
    const mock = vi.fn(async () => jsonResponse({ error: { type: 'authentication_error' } }, 401));
    global.fetch = mock as unknown as typeof fetch;
    await expect(listChats('bad', {})).rejects.toMatchObject({ status: 401 });
    expect(mock).toHaveBeenCalledTimes(1); // 401 is not retryable
  });

  it('retries on 429 and succeeds', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: { type: 'rate_limit_error' } }, 429, { 'retry-after': '0' });
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    const page = await listChats('k', {});
    expect(page.has_more).toBe(false);
    expect(calls).toBe(2);
  });

  it('does not retry a 404 whose body contains retryable-looking digits', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'not found, req_017429abc500' } }), { status: 404 }));
    global.fetch = mock as unknown as typeof fetch;
    await expect(listChats('k', {})).rejects.toMatchObject({ status: 404 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('listActivities defaults to order=asc and sends created_at.gte when no cursor exists', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await listActivities('k', { gteIso: '2026-07-15T00:00:00Z' });
    expect(capturedUrl).toContain('order=asc');
    expect(capturedUrl).toContain('created_at.gte=2026-07-15');
    expect(capturedUrl).not.toContain('after_id');
  });

  it('listActivities sends after_id (and no created_at.gte) when a cursor exists', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await listActivities('k', { afterId: 'cur' });
    expect(capturedUrl).toContain('order=asc');
    expect(capturedUrl).toContain('after_id=cur');
    expect(capturedUrl).not.toContain('created_at.gte');
  });

  it('listActivities honours an explicit order override', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await listActivities('k', { afterId: 'cur', order: 'desc' });
    expect(capturedUrl).toContain('order=desc');
  });

  it('getChatMessages parses a tool_use content block with connector fields intact', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      chat_messages: [{
        id: 'msg_1', role: 'assistant', created_at: '2026-07-15T00:00:00Z',
        content: [
          { type: 'tool_use', name: 'web_search', integration_name: 'jira', mcp_server_url: 'https://mcp.example.com/jira' },
          { type: 'text', text: 'hello' },
          { type: 'tool_result' },
        ],
      }],
      has_more: false, first_id: null, last_id: null,
    })) as unknown as typeof fetch;
    const page = await getChatMessages('k', 'claude_chat_1', {});
    const block = page.chat_messages[0].content[0];
    expect(block.type).toBe('tool_use');
    const toolUse = block as ComplianceToolUseBlock;
    expect(toolUse.name).toBe('web_search');
    expect(toolUse.integration_name).toBe('jira');
    expect(toolUse.mcp_server_url).toBe('https://mcp.example.com/jira');
  });
});

// --- fix/compliance-sync-efficiency ---------------------------------------
// 1. Server-side retention floor on the messages endpoint: syncChat already
//    discards every message older than its floor, so sending the bound lets
//    Anthropic leave them out instead of us paging through and dropping them.
// 2. retry-after is honoured in full (bounded), not silently capped at 30s —
//    a 60s instruction previously produced a guaranteed second 429.
describe('compliance client — messages retention bound', () => {
  it('getChatMessages sends created_at.gte when a floor is supplied', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ chat_messages: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await getChatMessages('k', 'claude_chat_1', { createdAtGte: '2026-08-12T00:00:00Z' });
    expect(capturedUrl).toContain('created_at.gte=2026-08-12');
  });

  it('getChatMessages omits created_at.gte when no floor is supplied', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse({ chat_messages: [], has_more: false, first_id: null, last_id: null });
    }) as unknown as typeof fetch;
    await getChatMessages('k', 'claude_chat_1', {});
    expect(capturedUrl).not.toContain('created_at.gte');
  });
});

describe('retryAfterSeconds', () => {
  it('honours the full instruction beyond the old 30s cap', () => {
    expect(retryAfterSeconds('60')).toBe(60);
    expect(retryAfterSeconds('45')).toBe(45);
  });

  it('passes small values through unchanged', () => {
    expect(retryAfterSeconds('1')).toBe(1);
    expect(retryAfterSeconds('25')).toBe(25);
  });

  it('falls back to 1 second when the header is missing, blank or nonsense', () => {
    expect(retryAfterSeconds(null)).toBe(1);
    expect(retryAfterSeconds('')).toBe(1);
    expect(retryAfterSeconds('soon')).toBe(1);
    expect(retryAfterSeconds('-5')).toBe(1);
  });

  it('bounds an absurd value so one response cannot stall a scheduler cycle', () => {
    expect(retryAfterSeconds('86400')).toBe(60);
  });
});

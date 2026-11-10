// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The OpenAI key test checks every log the sync reads: ChatGPT conversations,
// Codex logs and Codex turns for the workspace, and costs for the organisation
// once its ID is entered. A key that passed the test used to fail every sync
// when it lacked the Codex turns or costs permission.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', () => ({ requireAdmin: vi.fn(async () => true) }));
vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(async () => '') }));

const listLogFiles = vi.fn();
vi.mock('@/lib/openai/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/openai/client')>();
  return { ...actual, listLogFiles: (...args: unknown[]) => listLogFiles(...args) };
});

async function test(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/config/test/route');
  const res = await POST(new NextRequest('http://localhost/api/config/test', {
    method: 'POST',
    body: JSON.stringify({ key: 'openaiAdminApiKey', value: 'k', workspaceId: 'ws-1', ...body }),
  }));
  return res.json();
}

const called = () => listLogFiles.mock.calls.map(c => `${c[2]}:${c[1].kind}:${c[1].id}`);

beforeEach(() => {
  listLogFiles.mockReset();
  listLogFiles.mockResolvedValue({ data: [], has_more: false });
});

describe('OpenAI key test', () => {
  it('checks the three workspace logs and costs for the organisation', async () => {
    expect(await test({ organizationId: 'org-1' })).toEqual({ ok: true });
    expect(called()).toEqual([
      'CONVERSATION_MESSAGE:workspace:ws-1', 'CODEX_LOG:workspace:ws-1', 'CODEX_TURN:workspace:ws-1', 'COSTS:organization:org-1',
    ]);
  });

  it('without an organisation ID, skips costs and says so', async () => {
    const r = await test({ organizationId: '' });
    expect(r.ok).toBe(true);
    expect(r.note).toBe('Spend is not checked until you enter the OpenAI organisation ID.');
    expect(called()).not.toContain('COSTS:organization:');
  });

  it('names every log the key cannot read', async () => {
    const { OpenAiApiError } = await import('@/lib/openai/client');
    listLogFiles.mockImplementation(async (_k: string, _s: unknown, type: string) => {
      if (type === 'CODEX_TURN' || type === 'COSTS') throw new OpenAiApiError(403, 'forbidden');
      return { data: [], has_more: false };
    });
    const r = await test({ organizationId: 'org-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cannot read Codex turns, costs');
  });

  it('a wrong organisation ID is named as such', async () => {
    const { OpenAiApiError } = await import('@/lib/openai/client');
    listLogFiles.mockImplementation(async (_k: string, _s: unknown, type: string) => {
      if (type === 'COSTS') throw new OpenAiApiError(404, 'not found');
      return { data: [], has_more: false };
    });
    expect((await test({ organizationId: 'org-x' })).error).toBe('OpenAI did not find this organisation ID');
  });
});

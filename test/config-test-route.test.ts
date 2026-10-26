// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(async () => true),
}));

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn(async (key: string) => {
    // Return a test key for each config key type
    if (key === 'anthropicAiApiKey') return 'sk-ant-test-ai-key';
    if (key === 'anthropicAdminApiKey') return 'sk-ant-test-admin-key';
    if (key === 'anthropicAnalyticsApiKey') return 'sk-ant-test-analytics-key';
    if (key === 'complianceAccessKey') return 'sk-ant-test-compliance-key';
    return null;
  }),
}));

function makeRequest(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/config/test', {
    method,
    body: JSON.stringify(body),
  });
}

describe('POST /api/config/test', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('tests complianceAccessKey with the correct endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.anthropic.com/v1/compliance/apps/chats?limit=1');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock as any;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'complianceAccessKey', value: 'sk-ant-test-compliance-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('tests anthropicAdminApiKey with the correct endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.anthropic.com/v1/organizations/users?limit=1');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock as any;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAdminApiKey', value: 'sk-ant-test-admin-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('tests anthropicAnalyticsApiKey with the correct endpoint including computed date', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // Calculate expected date: 4 days ago UTC
      const fourDaysAgo = new Date(Date.now() - 4 * 86400_000).toISOString().split('T')[0];
      const expectedUrl = `https://api.anthropic.com/v1/organizations/analytics/users?date=${fourDaysAgo}&limit=1`;
      expect(url).toBe(expectedUrl);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock as any;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAnalyticsApiKey', value: 'sk-ant-test-analytics-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('404 response counts as failure (false-green regression test)', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAdminApiKey', value: 'sk-ant-test-admin-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });

  it('403 response returns ok: false with scope/plan error message', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAdminApiKey', value: 'sk-ant-test-admin-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('scope');
  });

  it('401 response returns ok: false with invalid key error message', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAdminApiKey', value: 'sk-ant-test-admin-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid');
  });

  it('200 response returns ok: true', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAdminApiKey', value: 'sk-ant-test-admin-key' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('anthropicAiApiKey uses GET /v1/models (model-agnostic, no hardcoded model)', async () => {
    const seen: { url: string; method?: string; body?: string } = { url: '' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.method = init?.method ?? 'GET';
      seen.body = init?.body as string | undefined;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock as any;

    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAiApiKey', value: 'sk-ant-test-ai-key' }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true });

    expect(seen.url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(seen.method).toBe('GET');
    // Regression: the AI-key test must NEVER depend on a hardcoded model id.
    expect(seen.body ?? '').not.toContain('claude-');
    expect(seen.body ?? '').not.toContain('model');
  });

  it('anthropicAiApiKey 401 returns invalid-key error', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    ) as any;
    const { POST } = await import('../app/api/config/test/route');
    const res = await POST(makeRequest('POST', { key: 'anthropicAiApiKey', value: 'sk-ant-test-ai-key' }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid');
  });
});

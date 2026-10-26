// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string } | null;
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(() => sessionResult),
}));

const configStore: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
}));

const fetchMock = vi.fn();

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/admin/alerts-slack/test', { method: 'POST' });
}

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/admin/alerts-slack/test', () => {
  it('403s a non-admin', async () => {
    sessionResult = null;
    const { POST } = await import('../app/api/admin/alerts-slack/test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('400s when no webhook URL is configured', async () => {
    const { POST } = await import('../app/api/admin/alerts-slack/test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a sample high-severity alert and returns ok when a webhook is configured', async () => {
    configStore['alertsSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
    const { POST } = await import('../app/api/admin/alerts-slack/test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.blocks)).toBe(true);
  });

  it('returns 502 when the webhook POST fails', async () => {
    configStore['alertsSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'error' });
    const { POST } = await import('../app/api/admin/alerts-slack/test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
  });
});

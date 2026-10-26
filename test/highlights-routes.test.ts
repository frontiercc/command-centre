// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──
const configStore: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
}));

let sessionResult: { authenticated: true; role: string; userId: string; email: string } | null;
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(() => sessionResult),
}));

const gatherHighlightsMock = vi.fn();
vi.mock('@/lib/highlights/gather', () => ({
  gatherHighlights: (...args: unknown[]) => gatherHighlightsMock(...args),
}));

const composeHighlightsMock = vi.fn();
vi.mock('@/lib/highlights/compose', () => ({
  composeHighlights: (...args: unknown[]) => composeHighlightsMock(...args),
}));

const postToSlackWebhookMock = vi.fn();
vi.mock('@/lib/slack/webhook', () => ({
  postToSlackWebhook: (...args: unknown[]) => postToSlackWebhookMock(...args),
}));

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({
  logAccess: (...args: unknown[]) => logAccessMock(...args),
}));

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/highlights', {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sampleInput = {
  weekStart: 0,
  weekEnd: 604800,
  headcount: 5,
  workItems: [{ index: 0, taskType: 'drafting', text: 'wrote a proposal' }],
  engineeringMix: [],
  systems: { totalCalls: 0, distinctSystems: 0, top: [] },
  codeOutput: null,
  tier3Count: 1,
  shoutouts: null,
};

const sampleComposed = {
  subject: 'client proposals',
  deliverables: [{ itemIndex: 0, sentence: 'A client-ready proposal drafted from a single request.' }],
};

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  gatherHighlightsMock.mockReset();
  composeHighlightsMock.mockReset();
  postToSlackWebhookMock.mockReset();
  logAccessMock.mockReset();
  sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
});

describe('flag off (highlightsEnabled unset/false)', () => {
  it('preview GET returns 404', async () => {
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(404);
  });

  it('send POST returns 404', async () => {
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'hello' }));
    expect(res.status).toBe(404);
  });

  it('status GET still returns {enabled:false,...} at 200', async () => {
    const { GET } = await import('../app/api/admin/highlights/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.enabled).toBe(false);
  });
});

describe('GET /api/admin/highlights (status)', () => {
  it('403s for a non-admin session even though the route is not flag-gated', async () => {
    sessionResult = null;
    const { GET } = await import('../app/api/admin/highlights/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('reports slackConfigured true only when digestSlackWebhookUrl is set', async () => {
    const { GET } = await import('../app/api/admin/highlights/route');
    const res = await GET(makeRequest('GET'));
    expect((await res.json()).slackConfigured).toBe(false);

    vi.resetModules();
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    const { GET: getAgain } = await import('../app/api/admin/highlights/route');
    const res2 = await getAgain(makeRequest('GET'));
    expect((await res2.json()).slackConfigured).toBe(true);
  });
});

describe('GET /api/admin/highlights/preview', () => {
  it('returns 422 no_content when gatherHighlights finds no work items, naming both causes, and logs a denied access event', async () => {
    configStore['highlightsEnabled'] = 'true';
    gatherHighlightsMock.mockResolvedValue({ ...sampleInput, workItems: [] });
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('no_content');
    expect(data.message).toMatch(/tier-3/i);
    expect(data.message).toMatch(/retention/i);
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'highlights', action: 'READ', outcome: 'denied' }));
  });

  it('returns 502 compose_failed when composeHighlights returns null, and logs a failure access event', async () => {
    configStore['highlightsEnabled'] = 'true';
    gatherHighlightsMock.mockResolvedValue(sampleInput);
    composeHighlightsMock.mockResolvedValue(null);
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe('compose_failed');
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'highlights', action: 'READ', outcome: 'failure' }));
  });

  it('happy path: 200 with a post containing the deliverable sentence, and logs a READ access event', async () => {
    configStore['highlightsEnabled'] = 'true';
    gatherHighlightsMock.mockResolvedValue(sampleInput);
    composeHighlightsMock.mockResolvedValue(sampleComposed);
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.post).toContain('A client-ready proposal drafted from a single request.');
    expect(data.deliverableCount).toBe(1);
    expect(data.weekStart).toBe(sampleInput.weekStart);
    expect(data.weekEnd).toBe(sampleInput.weekEnd);
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'highlights', action: 'READ' }));
  });

  it('passes includeNames from highlightsIncludeNames config into gatherHighlights', async () => {
    configStore['highlightsEnabled'] = 'true';
    configStore['highlightsIncludeNames'] = 'true';
    gatherHighlightsMock.mockResolvedValue(sampleInput);
    composeHighlightsMock.mockResolvedValue(sampleComposed);
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    await GET(makeRequest('GET'));
    expect(gatherHighlightsMock).toHaveBeenCalledWith({ includeNames: true });
  });

  it('403s for a non-admin session when the flag is on', async () => {
    configStore['highlightsEnabled'] = 'true';
    sessionResult = null;
    const { GET } = await import('../app/api/admin/highlights/preview/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/highlights/send', () => {
  beforeEach(() => {
    configStore['highlightsEnabled'] = 'true';
  });

  it('400s on blank text', async () => {
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: '   ' }));
    expect(res.status).toBe(400);
  });

  it('400s on missing text', async () => {
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', {}));
    expect(res.status).toBe(400);
  });

  it('400s on text over 8000 chars', async () => {
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'a'.repeat(8001) }));
    expect(res.status).toBe(400);
  });

  it('400s when digestSlackWebhookUrl is unset, naming the digest webhook', async () => {
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'A fine post.' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.toLowerCase()).toMatch(/digest/);
    expect(data.error.toLowerCase()).toMatch(/webhook/);
  });

  it('502s when postToSlackWebhook reports failure, and logs a failure access event', async () => {
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    postToSlackWebhookMock.mockResolvedValue({ ok: false, error: 'webhook responded 500' });
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'A fine post.' }));
    expect(res.status).toBe(502);
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'highlights', action: 'WRITE', outcome: 'failure' }));
  });

  it('happy path: posts {text} to the webhook, returns {ok:true}, and logs a WRITE access event', async () => {
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    postToSlackWebhookMock.mockResolvedValue({ ok: true });
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'A fine post.' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(postToSlackWebhookMock).toHaveBeenCalledWith('https://hooks.slack.com/services/x', { text: 'A fine post.' });
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'highlights', action: 'WRITE' }));
  });

  it('403s for a non-admin session when the flag is on', async () => {
    sessionResult = null;
    const { POST } = await import('../app/api/admin/highlights/send/route');
    const res = await POST(makeRequest('POST', { text: 'A fine post.' }));
    expect(res.status).toBe(403);
  });
});

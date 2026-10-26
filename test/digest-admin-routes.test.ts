// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──
const configStore: Record<string, string> = {};
const setConfigValueMock = vi.fn((key: string, value: string) => {
  configStore[key] = value;
});

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
  setConfigValue: (...args: [string, string]) => setConfigValueMock(...args),
}));

vi.mock('@/lib/email/smtp', () => ({
  isSmtpConfigured: vi.fn(() => !!configStore['smtpHost'] && !!configStore['smtpFromAddress']),
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

const buildDigestMock = vi.fn();
vi.mock('@/lib/digest/build', () => ({
  buildDigest: (...args: unknown[]) => buildDigestMock(...args),
}));

const renderDigestHtmlMock = vi.fn((..._args: unknown[]) => '<p>real digest html</p>');
vi.mock('@/lib/digest/render', () => ({
  renderDigestHtml: (...args: unknown[]) => renderDigestHtmlMock(...args),
  renderDigestSlack: vi.fn(() => ({ blocks: [] })),
}));

const sendDigestMock = vi.fn();
vi.mock('@/lib/digest/deliver', () => ({
  sendDigest: (...args: unknown[]) => sendDigestMock(...args),
}));

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/digest', {
    method: body ? 'PUT' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  setConfigValueMock.mockClear();
  buildDigestMock.mockReset();
  renderDigestHtmlMock.mockClear();
  sendDigestMock.mockReset();
  sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
});

describe('GET /api/admin/digest', () => {
  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'viewer' };
    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('masks a configured Slack webhook', async () => {
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';
    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.digestSlackWebhookUrl).toContain('••••••••');
    expect(data.digestSlackWebhookUrl).not.toBe(configStore['digestSlackWebhookUrl']);
  });

  it('reports channels.slack true only when webhook is set', async () => {
    const { GET: getNone } = await import('../app/api/admin/digest/route');
    const noneRes = await getNone(makeRequest());
    expect((await noneRes.json()).channels.slack).toBe(false);

    vi.resetModules();
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    const { GET: getSome } = await import('../app/api/admin/digest/route');
    const someRes = await getSome(makeRequest());
    expect((await someRes.json()).channels.slack).toBe(true);
  });

  it('reports "already sent this week" when digestLastSentWeek matches the current week', async () => {
    configStore['digestEnabled'] = 'true';
    configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/x';
    const { weekStart } = await import('@/lib/pulse/period');
    configStore['digestLastSentWeek'] = String(weekStart(Math.floor(Date.now() / 1000)));

    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.nextSendPreview).toBe('already sent this week');
  });

  it('reports "disabled" when digestEnabled is not true', async () => {
    const { GET } = await import('../app/api/admin/digest/route');
    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.nextSendPreview).toBe('disabled');
  });
});

describe('PUT /api/admin/digest', () => {
  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'manager' };
    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(makeRequest({ digestEnabled: 'true' }));
    expect(res.status).toBe(403);
  });

  it('rejects an out-of-range send hour', async () => {
    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(makeRequest({ digestSendHourUtc: '24' }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-https Slack webhook', async () => {
    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(makeRequest({ digestSlackWebhookUrl: 'http://example.com/hook' }));
    expect(res.status).toBe(400);
  });

  it('saves valid fields', async () => {
    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(makeRequest({
      digestEnabled: 'true',
      digestSendHourUtc: '9',
      digestRecipients: 'exec@example.com',
      digestSlackWebhookUrl: 'https://hooks.slack.com/services/x',
      digestHubUrl: 'https://hub.example.com',
    }));
    expect(res.status).toBe(200);
    expect(setConfigValueMock).toHaveBeenCalledWith('digestEnabled', 'true');
    expect(setConfigValueMock).toHaveBeenCalledWith('digestSendHourUtc', '9');
    expect(setConfigValueMock).toHaveBeenCalledWith('digestSlackWebhookUrl', 'https://hooks.slack.com/services/x');
  });

  it('does not overwrite the webhook when the masked placeholder is resubmitted', async () => {
    const { PUT } = await import('../app/api/admin/digest/route');
    const res = await PUT(makeRequest({ digestSlackWebhookUrl: 'https://hoo••••••••' }));
    expect(res.status).toBe(200);
    expect(setConfigValueMock).not.toHaveBeenCalledWith('digestSlackWebhookUrl', expect.anything());
  });
});

describe('GET /api/admin/digest/preview', () => {
  it('returns 403 for roles without pulse-admin access', async () => {
    sessionResult = { authenticated: true, role: 'viewer' };
    const { GET } = await import('../app/api/admin/digest/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('allows manager role', async () => {
    sessionResult = { authenticated: true, role: 'manager' };
    buildDigestMock.mockReturnValue(null);
    const { GET } = await import('../app/api/admin/digest/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('returns text/html content type', async () => {
    buildDigestMock.mockReturnValue(null);
    const { GET } = await import('../app/api/admin/digest/preview/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('prepends the sample watermark when buildDigest returns null', async () => {
    buildDigestMock.mockReturnValue(null);
    const { GET } = await import('../app/api/admin/digest/preview/route');
    const res = await GET(makeRequest());
    const html = await res.text();
    expect(html.toUpperCase()).toContain('SAMPLE DATA');
  });

  it('does not include the watermark when real digest data exists', async () => {
    buildDigestMock.mockReturnValue({
      weekStart: 0, weekEnd: 604800, code: null, cowork: null, anomaly: null, briefingExcerpt: null,
    });
    const { GET } = await import('../app/api/admin/digest/preview/route');
    const res = await GET(makeRequest());
    const html = await res.text();
    expect(html.toUpperCase()).not.toContain('SAMPLE DATA');
  });
});

describe('POST /api/admin/digest/test', () => {
  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'manager' };
    const { POST } = await import('../app/api/admin/digest/test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('sends using SAMPLE data when buildDigest returns null and reports isSample', async () => {
    buildDigestMock.mockReturnValue(null);
    sendDigestMock.mockResolvedValue({ email: 'skipped', slack: 'sent', errors: [] });
    const { POST } = await import('../app/api/admin/digest/test/route');
    const res = await POST(makeRequest());
    const data = await res.json();
    expect(data.isSample).toBe(true);
    expect(data.slack).toBe('sent');
    expect(setConfigValueMock).not.toHaveBeenCalledWith('digestLastSentWeek', expect.anything());
  });

  it('sends using real data when buildDigest returns data and reports isSample false', async () => {
    buildDigestMock.mockReturnValue({
      weekStart: 0, weekEnd: 604800, code: null, cowork: null, anomaly: null, briefingExcerpt: null,
    });
    sendDigestMock.mockResolvedValue({ email: 'sent', slack: 'skipped', errors: [] });
    const { POST } = await import('../app/api/admin/digest/test/route');
    const res = await POST(makeRequest());
    const data = await res.json();
    expect(data.isSample).toBe(false);
  });
});

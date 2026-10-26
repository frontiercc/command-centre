// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Cross-site request check in middleware.
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, originAllowed } from '../middleware';

function req(method: string, path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://hub.example.com${path}`, { method, headers: { host: 'hub.example.com', ...headers } });
}

describe('originAllowed', () => {
  it('allows a same-site state change', () => {
    expect(originAllowed(req('POST', '/api/config', { origin: 'https://hub.example.com' }))).toBe(true);
  });

  it('refuses a cross-site state change', () => {
    expect(originAllowed(req('POST', '/api/config', { origin: 'https://evil.example.net' }))).toBe(false);
    expect(originAllowed(req('DELETE', '/api/library/abc', { origin: 'https://evil.example.net' }))).toBe(false);
    expect(originAllowed(req('POST', '/api/admin/login', { origin: 'https://evil.example.net' }))).toBe(false);
  });

  it('refuses Origin: null', () => {
    expect(originAllowed(req('POST', '/api/config', { origin: 'null' }))).toBe(false);
  });

  it('allows a request with no Origin (non-browser client)', () => {
    expect(originAllowed(req('POST', '/api/config'))).toBe(true);
  });

  it('allows reads from anywhere (GET is not state-changing)', () => {
    expect(originAllowed(req('GET', '/api/config', { origin: 'https://evil.example.net' }))).toBe(true);
  });

  it('accepts a proxy-forwarded host when the gateway rewrote Host', () => {
    const r = req('POST', '/api/config', { host: '10.0.0.5:3000', 'x-forwarded-host': 'hub.example.com', origin: 'https://hub.example.com' });
    expect(originAllowed(r)).toBe(true);
    const r2 = req('POST', '/api/config', { host: '10.0.0.5:3000', 'x-original-host': 'hub.example.com', origin: 'https://hub.example.com' });
    expect(originAllowed(r2)).toBe(true);
  });

  it('keeps the port: localhost:3001 is not localhost:3010', () => {
    expect(originAllowed(req('POST', '/api/config', { host: 'localhost:3001', origin: 'http://localhost:3001' }))).toBe(true);
    expect(originAllowed(req('POST', '/api/config', { host: 'localhost:3001', origin: 'http://localhost:3010' }))).toBe(false);
  });

  it('a Host that spells out the default port still matches', () => {
    expect(originAllowed(req('POST', '/api/config', { host: 'hub.example.com:443', origin: 'https://hub.example.com' }))).toBe(true);
    expect(originAllowed(req('POST', '/api/config', { host: 'hub.example.com:80', origin: 'http://hub.example.com' }))).toBe(true);
    expect(originAllowed(req('POST', '/api/config', { host: 'hub.example.com:8443', origin: 'https://hub.example.com' }))).toBe(false);
  });

  it('an API path with a dot is still checked (it used to skip middleware entirely)', () => {
    const res = middleware(req('POST', '/api/library/some.connector', { origin: 'https://evil.example.net' }));
    expect(res.status).toBe(403);
  });

  it('exempts token-authenticated machine routes and SSO', () => {
    for (const p of ['/api/otel/ingest', '/api/export/summary', '/api/mcp', '/api/health', '/api/auth/sso/callback']) {
      expect(originAllowed(req('POST', p, { origin: 'https://collector.example.org' }))).toBe(true);
    }
  });

  it('no longer exempts the retired agent routes', () => {
    for (const p of ['/api/cowork/ingest', '/api/chat/ingest', '/api/errors/ingest', '/api/agents/enroll', '/api/agents/heartbeat']) {
      expect(originAllowed(req('POST', p, { origin: 'https://collector.example.org' }))).toBe(false);
    }
  });
});

describe('middleware', () => {
  it('answers 403 for a cross-site API write before any other check', async () => {
    const res = middleware(req('POST', '/api/config', { origin: 'https://evil.example.net' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cross-site request refused' });
  });

  it('a same-site write carries on to the normal session check', () => {
    const res = middleware(req('POST', '/api/config', { origin: 'https://hub.example.com' }));
    expect(res.status).toBe(401); // no session cookie: the existing check, not the Origin check
  });
});

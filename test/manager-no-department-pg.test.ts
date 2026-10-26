// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A manager reads prompt text for their own department only, so a manager
// with no department reads none until an admin sets one. The Audit Log list
// (GET /api/events) and the gated prompt routes (gateContentRead) refuse such
// a manager with 403 no_department; a manager with a department and an admin
// are still allowed.
//
// HARNESS RULE (copied from test/events-chat-source.test.ts): the route and
// schema modules are imported after createTestDbClient('postgres') has set
// DATABASE_URL and reset modules.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null } = {
  authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test', department: null,
};
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => sessionResult };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

describe('a manager with no department reads no prompt text', () => {
  it('is refused by the Audit Log list and the conversation view; others are not', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { cleanup } = await createTestDbClient('postgres');
    try {
      const events = await import('@/app/api/events/route');
      const messages = await import('@/app/api/cowork/messages/route');

      sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm1@x.test', department: null };
      for (const res of [
        await events.GET(makeRequest('/api/events?limit=5')),
        await events.GET(makeRequest('/api/events?limit=5&department=Finance')),
        await messages.GET(makeRequest('/api/cowork/messages?sessionId=s1')),
      ]) {
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('no_department');
      }

      sessionResult = { authenticated: true, role: 'manager', userId: 'm2', email: 'm2@x.test', department: 'Finance' };
      expect((await events.GET(makeRequest('/api/events?limit=5'))).status).toBe(200);
      expect((await messages.GET(makeRequest('/api/cowork/messages?sessionId=s1'))).status).toBe(200);

      sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test', department: null };
      expect((await events.GET(makeRequest('/api/events?limit=5'))).status).toBe(200);
      expect((await messages.GET(makeRequest('/api/cowork/messages?sessionId=s1'))).status).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

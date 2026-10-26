// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}

const DEFAULTS: Record<string, string> = {
  skillDraftMinPeople: '3', skillDraftMinPrompts: '10', skillDraftMinDays: '3',
  skillDraftMinFollowUps: '3', skillDraftSoloMinDays: '6', skillDraftSoloMinWeeks: '4',
  skillDraftModel: 'claude-sonnet-5',
};

describe('skill drafting config keys', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');
  beforeAll(async () => {
    const t = await createTestDatabase(); cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  for (const [key, def] of Object.entries(DEFAULTS)) {
    it(`${key} defaults to "${def}"`, async () => {
      expect((await cfg.getAllConfig() as unknown as Record<string, string>)[key]).toBe(def);
    });
  }

  it('all seven round-trip through POST /api/config (they are in allowedKeys)', async () => {
    const { POST } = await import('@/app/api/config/route');
    const res = await POST(makePostRequest({
      skillDraftMinPeople: '4', skillDraftMinPrompts: '12', skillDraftMinDays: '4',
      skillDraftMinFollowUps: '5', skillDraftSoloMinDays: '8', skillDraftSoloMinWeeks: '6',
      skillDraftModel: 'claude-haiku-4-5-20251001',
    }));
    expect(res.status).toBe(200);
    const all = await cfg.getAllConfig() as unknown as Record<string, string>;
    expect(all.skillDraftMinPeople).toBe('4');
    expect(all.skillDraftSoloMinWeeks).toBe('6');
    expect(all.skillDraftModel).toBe('claude-haiku-4-5-20251001');
  });
});

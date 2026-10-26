// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Department Process Transformation: seven new process-mining config
 * keys (processMiningIntervalDays/WindowDays/MinUsers/
 * MaxOpenPerDept/Model/Denylist), the job-written processMiningLastRun key
 * (NOT in allowedKeys), and the useCasesSuggestUseContent default flip
 * 'false' -> 'true' (content-informed suggestions now on by default).
 *
 * Follows the pattern of test/use-cases-config.test.ts: defaults asserted via
 * getAllConfig(), allowedKeys membership asserted by round-tripping through
 * POST /api/config (no exported allowedKeys set to import/regex).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

vi.mock('@/lib/audit/log', () => ({
  logAccess: vi.fn(),
}));

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Department process mining config keys', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  describe('defaults (empty config table)', () => {
    it('processMiningIntervalDays defaults to "7"', async () => {
      expect((await cfg.getAllConfig()).processMiningIntervalDays).toBe('7');
    });
    it('processMiningWindowDays defaults to "28"', async () => {
      expect((await cfg.getAllConfig()).processMiningWindowDays).toBe('28');
    });
    it('processMiningMinUsers defaults to "2"', async () => {
      expect((await cfg.getAllConfig()).processMiningMinUsers).toBe('2');
    });
    it('processMiningMaxOpenPerDept defaults to "5"', async () => {
      expect((await cfg.getAllConfig()).processMiningMaxOpenPerDept).toBe('5');
    });
    it('processMiningModel defaults to ""', async () => {
      expect((await cfg.getAllConfig()).processMiningModel).toBe('');
    });
    it('processMiningDenylist defaults to "" (code falls back to a default list)', async () => {
      expect((await cfg.getAllConfig()).processMiningDenylist).toBe('');
    });
    it('processMiningLastRun (job-written) defaults to ""', async () => {
      expect((await cfg.getAllConfig()).processMiningLastRun).toBe('');
    });
    it('useCasesSuggestUseContent now defaults to "true"', async () => {
      expect((await cfg.getAllConfig()).useCasesSuggestUseContent).toBe('true');
    });
  });

  describe('round-trip via getConfigValue/setConfigValue', () => {
    it('processMiningIntervalDays round-trips', async () => {
      await cfg.setConfigValue('processMiningIntervalDays', '14');
      expect(await cfg.getConfigValue('processMiningIntervalDays')).toBe('14');
      expect((await cfg.getAllConfig()).processMiningIntervalDays).toBe('14');
      await cfg.setConfigValue('processMiningIntervalDays', '');
    });
  });

  describe('POST /api/config write — allowedKeys membership', () => {
    it('persists all seven admin-saved process-mining keys together', async () => {
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({
        processMiningIntervalDays: '14',
        processMiningWindowDays: '21',
        processMiningMinUsers: '3',
        processMiningMaxOpenPerDept: '8',
        processMiningModel: 'claude-haiku-4-5-20251001',
        processMiningDenylist: JSON.stringify(['reporting', 'drafting']),
      }));
      expect(res.status).toBe(200);
      const all = await cfg.getAllConfig();
      expect(all.processMiningIntervalDays).toBe('14');
      expect(all.processMiningWindowDays).toBe('21');
      expect(all.processMiningMinUsers).toBe('3');
      expect(all.processMiningMaxOpenPerDept).toBe('8');
      expect(all.processMiningModel).toBe('claude-haiku-4-5-20251001');
      expect(JSON.parse(all.processMiningDenylist)).toEqual(['reporting', 'drafting']);
    });

    it('does NOT persist processMiningLastRun — job-only key, not in allowedKeys', async () => {
      await cfg.setConfigValue('processMiningLastRun', '');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ processMiningLastRun: '1234567890' }));
      // Route ignores unknown/disallowed keys silently rather than erroring.
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).processMiningLastRun).toBe('');
    });
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for five Use Cases config keys: useCasesTrackerIntervalHours
 * (admin-editable cadence knob) plus the four lifecycle thresholds
 * (useCasesAdoptedMinWeeks / useCasesAdoptedMinUsers / useCasesAtRiskQuietWeeks /
 * useCasesNotSeenQuietWeeks) consumed by lib/usecases/lifecycle.ts.
 *
 * Also asserts the two job-written-only keys (useCasesTrackerLastRun,
 * useCasesTrackerCursors) are NOT in allowedKeys — POST /api/config must not
 * persist them, mirroring how sso-config.test.ts / config-licensed-seats.test.ts
 * assert allowed vs rejected keys.
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

describe('Use Cases lifecycle + cadence config keys', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
    sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  });
  afterAll(async () => cleanup());

  describe('defaults', () => {
    it('useCasesAdoptedMinWeeks defaults to "3"', async () => {
      expect((await cfg.getAllConfig()).useCasesAdoptedMinWeeks).toBe('3');
    });
    it('useCasesAdoptedMinUsers defaults to "2"', async () => {
      expect((await cfg.getAllConfig()).useCasesAdoptedMinUsers).toBe('2');
    });
    it('useCasesAtRiskQuietWeeks defaults to "2"', async () => {
      expect((await cfg.getAllConfig()).useCasesAtRiskQuietWeeks).toBe('2');
    });
    it('useCasesNotSeenQuietWeeks defaults to "6"', async () => {
      expect((await cfg.getAllConfig()).useCasesNotSeenQuietWeeks).toBe('6');
    });
    it('useCasesTrackerIntervalHours defaults to "1"', async () => {
      expect((await cfg.getAllConfig()).useCasesTrackerIntervalHours).toBe('1');
    });
    it('useCasesTrackerLastRun and useCasesTrackerCursors default to ""', async () => {
      const all = (await cfg.getAllConfig());
      expect(all.useCasesTrackerLastRun).toBe('');
      expect(all.useCasesTrackerCursors).toBe('');
    });
  });

  describe('round-trip via getConfigValue/setConfigValue', () => {
    it('useCasesAdoptedMinWeeks round-trips', async () => {
      await cfg.setConfigValue('useCasesAdoptedMinWeeks', '4');
      expect(await cfg.getConfigValue('useCasesAdoptedMinWeeks')).toBe('4');
      expect((await cfg.getAllConfig()).useCasesAdoptedMinWeeks).toBe('4');
    });

    it('useCasesTrackerIntervalHours round-trips', async () => {
      await cfg.setConfigValue('useCasesTrackerIntervalHours', '6');
      expect(await cfg.getConfigValue('useCasesTrackerIntervalHours')).toBe('6');
      expect((await cfg.getAllConfig()).useCasesTrackerIntervalHours).toBe('6');
    });
  });

  describe('POST /api/config write', () => {
    it('persists useCasesAdoptedMinWeeks: "4" via POST /api/config', async () => {
      await cfg.setConfigValue('useCasesAdoptedMinWeeks', '3');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ useCasesAdoptedMinWeeks: '4' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).useCasesAdoptedMinWeeks).toBe('4');
    });

    it('persists all five admin-editable keys together', async () => {
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({
        useCasesAdoptedMinWeeks: '4',
        useCasesAdoptedMinUsers: '3',
        useCasesAtRiskQuietWeeks: '3',
        useCasesNotSeenQuietWeeks: '8',
        useCasesTrackerIntervalHours: '4',
      }));
      expect(res.status).toBe(200);
      const all = (await cfg.getAllConfig());
      expect(all.useCasesAdoptedMinWeeks).toBe('4');
      expect(all.useCasesAdoptedMinUsers).toBe('3');
      expect(all.useCasesAtRiskQuietWeeks).toBe('3');
      expect(all.useCasesNotSeenQuietWeeks).toBe('8');
      expect(all.useCasesTrackerIntervalHours).toBe('4');
    });

    it('does NOT persist useCasesTrackerCursors — job-only key, not in allowedKeys', async () => {
      await cfg.setConfigValue('useCasesTrackerCursors', '');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ useCasesTrackerCursors: 'some-cursor-value' }));
      // Route ignores unknown/disallowed keys silently rather than erroring.
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).useCasesTrackerCursors).toBe('');
    });

    it('does NOT persist useCasesTrackerLastRun — job-only key, not in allowedKeys', async () => {
      await cfg.setConfigValue('useCasesTrackerLastRun', '');
      const { POST } = await import('../app/api/config/route');
      const res = await POST(makePostRequest({ useCasesTrackerLastRun: '1234567890' }));
      expect(res.status).toBe(200);
      expect((await cfg.getAllConfig()).useCasesTrackerLastRun).toBe('');
    });

    it('persists useCasesSuggestExcludedSignals as a JSON array string via POST /api/config', async () => {
      const { POST } = await import('../app/api/config/route');
      const value = JSON.stringify(['anthropic-skills:docx', 'basic_drafting', 'transcription']);
      const res = await POST(makePostRequest({ useCasesSuggestExcludedSignals: value }));
      expect(res.status).toBe(200);
      const all = (await cfg.getAllConfig());
      expect(all.useCasesSuggestExcludedSignals).toBe(value);
      expect(JSON.parse(all.useCasesSuggestExcludedSignals)).toEqual(['anthropic-skills:docx', 'basic_drafting', 'transcription']);
    });
  });

  describe('governance value calibration defaults', () => {
    it('defaults minutes-saved and loaded comp', async () => {
      const { getAllConfig } = await import('@/lib/config');
      const cfg = await getAllConfig();
      expect(cfg.useCasesMinutesSavedPerSession).toBe('30');
      expect(cfg.useCasesLoadedCompAnnual).toBe('90000');
    });
  });

  describe('content-informed suggestions toggle default', () => {
    it('defaults useCasesSuggestUseContent to true (Department Process Transformation Task 2 default flip)', async () => {
      const { getAllConfig } = await import('@/lib/config');
      expect((await getAllConfig()).useCasesSuggestUseContent).toBe('true');
    });
  });
});

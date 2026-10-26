// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

// The refresh route runs department process mining only (the
// tool-combination tray it also ran was retired).
const mockRunProcessMiningJob = vi.fn();
vi.mock('@/lib/usecases/process-mining', () => ({
  runProcessMiningJob: (...args: unknown[]) => mockRunProcessMiningJob(...args),
}));

function makeRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.resetModules();
  mockRunProcessMiningJob.mockReset();
  await sql.exec('DELETE FROM use_case_suggestions');
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM config');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

async function seedSuggestion(overrides: { signalKey: string; title: string; status?: 'open' | 'dismissed' | 'added'; department?: string | null; canvas?: boolean }) {
  const { upsertOpenSuggestion, setSuggestionStatus, listOpenSuggestions } = await import('@/lib/usecases/suggestion-store');
  await upsertOpenSuggestion({
    signalKey: overrides.signalKey,
    title: overrides.title,
    description: 'desc',
    department: overrides.department === undefined ? 'Marketing' : (overrides.department ?? undefined),
    matchingRule: { skills: ['deep-research'], connectors: ['notion'], taskTypes: [], departments: ['Marketing'] },
    evidence: { distinctUsers: 5, sessionCount: 10, departments: ['Marketing'] },
    nowS: Math.floor(Date.now() / 1000),
    ...(overrides.canvas ? { canvas: { story: 's', valueHypothesis: 'v', departments: ['Finance', 'Sales'], people: 4, sessions: 6, occasions: 4, windowDays: 28, rhythm: { label: 'weekly' as const, display: 'Weekly' }, systems: [], activeHours: null, tierNote: null } } : {}),
  });
  const created = (await listOpenSuggestions()).find(s => s.signalKey === overrides.signalKey)!;
  if (overrides.status && overrides.status !== 'open') {
    await setSuggestionStatus(created.id, overrides.status);
  }
  return created;
}

describe('GET /api/use-cases/suggestions', () => {
  it('returns 404 when useCasesEnabled is off', async () => {
    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a viewer role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(403);
  });

  it('returns only open department suggestions, excluding dismissed ones and the retired org-wide rows', async () => {
    await enableUseCases();
    await seedSuggestion({ signalKey: 'k1', title: 'Open one' });
    await seedSuggestion({ signalKey: 'k2', title: 'Open two' });
    await seedSuggestion({ signalKey: 'k3', title: 'Dismissed one', status: 'dismissed' });
    await seedSuggestion({ signalKey: 'k4', title: 'Old org-wide tray row', department: null });
    await seedSuggestion({ signalKey: 'k5', title: 'Across departments one', department: null, canvas: true });

    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Department rows and cross-department processes (department null WITH a canvas); never the old tray rows.
    expect(body.map((s: { title: string }) => s.title).sort()).toEqual(['Across departments one', 'Open one', 'Open two']);
  });
});

describe('POST /api/use-cases/suggestions/refresh', () => {
  it('returns 404 when useCasesEnabled is off', async () => {
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(404);
    expect(mockRunProcessMiningJob).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a viewer role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(403);
  });

  it('runs mining with force:true and returns its count when last run is old/absent', async () => {
    await enableUseCases();
    mockRunProcessMiningJob.mockResolvedValueOnce({ generated: 3, departments: 2 });
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 3, processGenerated: 3, throttled: false, failed: false });
    expect(mockRunProcessMiningJob).toHaveBeenCalledWith({ force: true });
  });

  it('throttles: returns {generated:0, throttled:true} without calling the job when last run was recent', async () => {
    await enableUseCases();
    const { setConfigValue } = await import('@/lib/config');
    const nowS = Math.floor(Date.now() / 1000);
    await setConfigValue('processMiningLastRun', String(nowS));

    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 0, processGenerated: 0, throttled: true });
    expect(mockRunProcessMiningJob).not.toHaveBeenCalled();
  });

  it('does not throttle when last run is older than the throttle window', async () => {
    await enableUseCases();
    const { setConfigValue } = await import('@/lib/config');
    const nowS = Math.floor(Date.now() / 1000);
    await setConfigValue('processMiningLastRun', String(nowS - 121));
    mockRunProcessMiningJob.mockResolvedValueOnce({ generated: 1, departments: 1 });

    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 1, processGenerated: 1, throttled: false, failed: false });
    expect(mockRunProcessMiningJob).toHaveBeenCalledWith({ force: true });
  });
});

describe('PATCH /api/use-cases/suggestions/[id]', () => {
  it('returns 404 when useCasesEnabled is off', async () => {
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/abc', 'PATCH', { action: 'dismiss' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/abc', 'PATCH', { action: 'dismiss' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a viewer role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/abc', 'PATCH', { action: 'dismiss' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a missing suggestion id', async () => {
    await enableUseCases();
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/does-not-exist', 'PATCH', { action: 'dismiss' }), {
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid action', async () => {
    await enableUseCases();
    const created = await seedSuggestion({ signalKey: 'k-invalid', title: 'Some suggestion' });
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', { action: 'bogus' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(400);
  });

  it('dismiss: marks the suggestion dismissed and it drops out of GET', async () => {
    await enableUseCases();
    const created = await seedSuggestion({ signalKey: 'k-dismiss', title: 'To dismiss' });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', { action: 'dismiss' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { getSuggestionById } = await import('@/lib/usecases/suggestion-store');
    expect((await getSuggestionById(created.id))!.status).toBe('dismissed');

    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const listRes = await GET(makeRequest('/api/use-cases/suggestions'));
    const list = await listRes.json();
    expect(list.find((s: { id: string }) => s.id === created.id)).toBeUndefined();
  });

  it('add: a legacy org-wide row still creates a candidate use case (origin emergent, capture_method suggested), marks the suggestion added, returns useCaseId', async () => {
    await enableUseCases();
    const created = await seedSuggestion({ signalKey: 'k-add', title: 'Research briefs', department: null });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', { action: 'add' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.useCaseId).toBeTruthy();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc).toBeDefined();
    expect(uc!.title).toBe('Research briefs');
    expect(uc!.origin).toBe('emergent');
    expect(uc!.status).toBe('candidate');
    expect(uc!.captureMethod).toBe('suggested');
    expect(uc!.skills).toEqual(['deep-research']);
    expect(uc!.connectors).toEqual(['notion']);
    expect(uc!.departments).toEqual(['Marketing']);
    expect(uc!.createdBy).toBe('admin-1');

    const { getSuggestionById } = await import('@/lib/usecases/suggestion-store');
    expect((await getSuggestionById(created.id))!.status).toBe('added');
  });

  it('add: a cross-department process lands as a candidate, process-mined', async () => {
    await enableUseCases();
    const created = await seedSuggestion({ signalKey: 'k-across', title: 'Weekly team briefing', department: null, canvas: true });
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', { action: 'add' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase((await res.json()).useCaseId);
    expect(uc).toMatchObject({ status: 'candidate', captureMethod: 'process_mined', title: 'Weekly team briefing' });
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';

let sql: TestSql;
let cleanup: () => Promise<void>;

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

const mockRunProcessMiningJob = vi.fn();
vi.mock('@/lib/usecases/process-mining', () => ({
  runProcessMiningJob: (...args: unknown[]) => mockRunProcessMiningJob(...args),
}));

const mockBootstrapUseCase = vi.fn((...args: unknown[]) => Promise.resolve(args));
vi.mock('@/lib/usecases/tracker', () => ({
  bootstrapUseCase: (...args: unknown[]) => mockBootstrapUseCase(...args),
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
  mockBootstrapUseCase.mockClear();
  await sql.exec('DELETE FROM use_case_suggestions');
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM config');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

const SAMPLE_CANVAS: ProcessCanvas = {
  story: 'People in Finance keep reconciling spreadsheets by hand every month-end.',
  valueHypothesis: 'Automating the reconciliation could save a day per close.',
  people: 4,
  sessions: 12,
  occasions: 6,
  windowDays: 28,
  rhythm: { label: 'monthly', display: 'monthly' },
  systems: ['netsuite', 'excel'],
  activeHours: 3.5,
  tierNote: 'Tier 2 delegation on average',
};

async function seedSuggestion(overrides: {
  signalKey: string;
  title: string;
  status?: 'open' | 'dismissed' | 'added';
  department?: string;
  canvas?: ProcessCanvas;
  keywords?: string[];
}) {
  const { upsertOpenSuggestion, setSuggestionStatus, listOpenSuggestions } = await import('@/lib/usecases/suggestion-store');
  await upsertOpenSuggestion({
    signalKey: overrides.signalKey,
    title: overrides.title,
    description: 'desc',
    matchingRule: {
      skills: ['deep-research'],
      connectors: ['notion'],
      taskTypes: [],
      departments: [overrides.department ?? 'Marketing'],
      keywords: overrides.keywords ?? ['reconciliation'],
    },
    evidence: { distinctUsers: 5, sessionCount: 10, departments: [overrides.department ?? 'Marketing'] },
    nowS: Math.floor(Date.now() / 1000),
    department: overrides.department,
    canvas: overrides.canvas,
  });
  const created = (await listOpenSuggestions()).find(s => s.signalKey === overrides.signalKey)!;
  if (overrides.status && overrides.status !== 'open') {
    await setSuggestionStatus(created.id, overrides.status);
  }
  return created;
}

describe('GET /api/use-cases/suggestions — department + canvas fields', () => {
  it('returns department and canvas for a seeded dept-scoped row', async () => {
    await enableUseCases();
    await seedSuggestion({
      signalKey: 'dept-k1',
      title: 'Finance reconciliation',
      department: 'Finance',
      canvas: SAMPLE_CANVAS,
    });

    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.find((s: { title: string }) => s.title === 'Finance reconciliation');
    expect(row).toBeDefined();
    expect(row.department).toBe('Finance');
    expect(row.canvas).toEqual(SAMPLE_CANVAS);
  });

  it('hides the retired org-wide tray rows (department null)', async () => {
    await enableUseCases();
    await seedSuggestion({ signalKey: 'org-k1', title: 'Org-wide cluster' });
    await seedSuggestion({ signalKey: 'dept-k1', title: 'Finance dept row', department: 'Finance', canvas: SAMPLE_CANVAS });

    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(200);
    const titles = (await res.json()).map((s: { title: string }) => s.title);
    expect(titles).toEqual(['Finance dept row']);
  });

  it('content analysis off hides every suggestion (they are all content-derived now); rows are kept', async () => {
    await enableUseCases();
    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ useCasesSuggestUseContent: 'false' });
    await seedSuggestion({ signalKey: 'dept-content-off', title: 'Finance dept row', department: 'Finance', canvas: SAMPLE_CANVAS });

    const { GET } = await import('../app/api/use-cases/suggestions/route');
    const res = await GET(makeRequest('/api/use-cases/suggestions'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(await sql.get(`SELECT count(*)::int AS n FROM use_case_suggestions`)).toEqual({ n: 1 });
  });
});

describe('PATCH /api/use-cases/suggestions/[id] — action: add with confirm slots', () => {
  it('dept row + slots: stores ownerUserId/baselineNote/kpiNote, valueNote wins over canvas.valueHypothesis, painPoint = canvas.story, keywords from matchingRule, departments [dept], origin emergent, captureMethod process_mined, suggestion flips to added', async () => {
    await enableUseCases();
    const created = await seedSuggestion({
      signalKey: 'dept-add-1',
      title: 'Finance reconciliation',
      department: 'Finance',
      canvas: SAMPLE_CANVAS,
      keywords: ['reconciliation', 'month-end'],
    });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(
      jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', {
        action: 'add',
        ownerUserId: 'user-42',
        baselineNote: 'Currently takes 2 days per close',
        valueNote: 'Explicit value note wins',
        kpiNote: 'Days to close',
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.useCaseId).toBeTruthy();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc).toBeDefined();
    expect(uc!.title).toBe('Finance reconciliation');
    expect(uc!.origin).toBe('emergent');
    expect(uc!.status).toBe('confirmed');
    expect(uc!.captureMethod).toBe('process_mined');
    expect(mockBootstrapUseCase).toHaveBeenCalledWith(body.useCaseId);
    expect(uc!.ownerUserId).toBe('user-42');
    expect(uc!.baselineNote).toBe('Currently takes 2 days per close');
    expect(uc!.kpiNote).toBe('Days to close');
    expect(uc!.valueHypothesis).toBe('Explicit value note wins');
    expect(uc!.painPoint).toBe(SAMPLE_CANVAS.story);
    expect(uc!.keywords).toEqual(['reconciliation', 'month-end']);
    expect(uc!.departments).toEqual(['Finance']);

    const { getSuggestionById } = await import('@/lib/usecases/suggestion-store');
    expect((await getSuggestionById(created.id))!.status).toBe('added');
  });

  it('dept row without a valueNote falls back to canvas.valueHypothesis', async () => {
    await enableUseCases();
    const created = await seedSuggestion({
      signalKey: 'dept-add-2',
      title: 'Finance reconciliation 2',
      department: 'Finance',
      canvas: SAMPLE_CANVAS,
    });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(
      jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', { action: 'add' }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc!.valueHypothesis).toBe(SAMPLE_CANVAS.valueHypothesis);
    expect(uc!.painPoint).toBe(SAMPLE_CANVAS.story);
    expect(uc!.captureMethod).toBe('process_mined');
    expect(uc!.status).toBe('confirmed');
    expect(mockBootstrapUseCase).toHaveBeenCalledWith(body.useCaseId);
  });

  it('org row (no department/canvas): captureMethod stays suggested, no canvas fields stored', async () => {
    await enableUseCases();
    const created = await seedSuggestion({ signalKey: 'org-add-1', title: 'Org-wide research briefs' });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(
      jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', {
        action: 'add',
        ownerUserId: 'user-9',
        baselineNote: 'should be stored regardless of dept',
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc!.captureMethod).toBe('suggested');
    expect(uc!.status).toBe('candidate');
    expect(uc!.painPoint).toBeNull();
    expect(uc!.valueHypothesis).toBeNull();
    // Slot fields are independent of dept-scoping — they still round-trip.
    expect(uc!.ownerUserId).toBe('user-9');
    expect(uc!.baselineNote).toBe('should be stored regardless of dept');
    expect(mockBootstrapUseCase).not.toHaveBeenCalled();
  });

  it('slot strings are truncated: ownerUserId to 200 chars, notes to 500 chars', async () => {
    await enableUseCases();
    const created = await seedSuggestion({
      signalKey: 'dept-add-3',
      title: 'Finance reconciliation 3',
      department: 'Finance',
      canvas: SAMPLE_CANVAS,
    });

    const longOwner = 'o'.repeat(300);
    const longNote = 'n'.repeat(600);

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(
      jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', {
        action: 'add',
        ownerUserId: longOwner,
        baselineNote: longNote,
        valueNote: longNote,
        kpiNote: longNote,
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const body = await res.json();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc!.ownerUserId).toBe(longOwner.slice(0, 200));
    expect(uc!.baselineNote).toBe(longNote.slice(0, 500));
    expect(uc!.valueHypothesis).toBe(longNote.slice(0, 500));
    expect(uc!.kpiNote).toBe(longNote.slice(0, 500));
  });

  it('non-string slot fields are ignored (undefined, not stored)', async () => {
    await enableUseCases();
    const created = await seedSuggestion({
      signalKey: 'dept-add-4',
      title: 'Finance reconciliation 4',
      department: 'Finance',
      canvas: SAMPLE_CANVAS,
    });

    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(
      jsonRequest(`/api/use-cases/suggestions/${created.id}`, 'PATCH', {
        action: 'add',
        ownerUserId: 12345,
        baselineNote: { not: 'a string' },
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const body = await res.json();

    const { getUseCase } = await import('@/lib/usecases/queries');
    const uc = await getUseCase(body.useCaseId);
    expect(uc!.ownerUserId).toBeNull();
    expect(uc!.baselineNote).toBeNull();
  });

  it('flag-off returns 404 before auth is checked', async () => {
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/abc', 'PATCH', { action: 'add' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(404);
  });

  it('non-admin/manager (viewer) gets 403', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { PATCH } = await import('../app/api/use-cases/suggestions/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/suggestions/abc', 'PATCH', { action: 'add' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/use-cases/suggestions/refresh — runs department mining', () => {
  it('runs mining with force:true and returns its count', async () => {
    await enableUseCases();
    mockRunProcessMiningJob.mockResolvedValueOnce({ generated: 2, departments: 1 });

    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 2, processGenerated: 2, throttled: false, failed: false });
    expect(mockRunProcessMiningJob).toHaveBeenCalledWith({ force: true });
  });

  it('a mining failure is reported, not hidden as "nothing found"', async () => {
    await enableUseCases();
    mockRunProcessMiningJob.mockRejectedValueOnce(new Error('Process mining failed for 1 department(s)'));

    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 0, processGenerated: 0, throttled: false, failed: true });
  });

  it('is throttled for 120 seconds after the last mining run', async () => {
    await enableUseCases();
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('processMiningLastRun', String(Math.floor(Date.now() / 1000)));

    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: 0, processGenerated: 0, throttled: true });
    expect(mockRunProcessMiningJob).not.toHaveBeenCalled();
  });

  it('flag-off returns 404 before auth', async () => {
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(404);
    expect(mockRunProcessMiningJob).not.toHaveBeenCalled();
    expect(mockRunProcessMiningJob).not.toHaveBeenCalled();
  });

  it('non-admin/manager (viewer) gets 403', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { POST } = await import('../app/api/use-cases/suggestions/refresh/route');
    const res = await POST(makeRequest('/api/use-cases/suggestions/refresh', { method: 'POST' }));
    expect(res.status).toBe(403);
  });
});

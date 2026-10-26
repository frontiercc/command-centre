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

const bootstrapUseCaseMock = vi.fn((...args: unknown[]) => Promise.resolve(args));
vi.mock('@/lib/usecases/tracker', () => ({
  bootstrapUseCase: (id: string) => bootstrapUseCaseMock(id),
}));

function makeRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  // Creating a use case needs a description (sessions are
  // judged against it); tests that do not care about it get a default here.
  const withDesc = method === 'POST' && url === '/api/use-cases' && body && typeof body === 'object' && !('description' in (body as object))
    ? { ...(body as object), description: 'Test work: what it is and what it produces.' }
    : body;
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: withDesc !== undefined ? JSON.stringify(withDesc) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One session judged to be the use case's work: the judgement row plus its weekly match. */
async function seedJudgedSession(ucId: string, sessionId: string, userId: string, lastAt: number) {
  await sql.run(`INSERT INTO use_case_session_judgements (session_id, surface, user_id, use_case_ids, candidate_key, prompt_count, first_event_at, last_event_at, judged_at)
    VALUES (?, 'cowork', ?, ?, 'k', 2, ?, ?, ?)`, [sessionId, userId, JSON.stringify([ucId]), lastAt - 600, lastAt, lastAt]);
  const wk = Math.floor((lastAt - 600) / 86400 / 7) * 7 * 86400;
  await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, ?, ?)`, [ucId, wk, userId, sessionId]);
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.resetModules();
  await sql.exec('DELETE FROM use_case_session_judgements');
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM config');
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM cowork_skill_invocations');
  await sql.exec('DELETE FROM users');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
  bootstrapUseCaseMock.mockClear();
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

describe('config gate — useCasesEnabled', () => {
  it('GET /api/use-cases returns 404 when disabled', async () => {
    const { GET } = await import('../app/api/use-cases/route');
    const res = await GET(makeRequest('/api/use-cases'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('POST /api/use-cases returns 404 when disabled', async () => {
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(jsonRequest('/api/use-cases', 'POST', { title: 'X' }));
    expect(res.status).toBe(404);
  });

  it('GET /api/use-cases/[id] returns 404 when disabled', async () => {
    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(makeRequest('/api/use-cases/abc'), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(404);
  });

  it('POST /api/use-cases/[id]/activate returns 404 when disabled', async () => {
    const { POST } = await import('../app/api/use-cases/[id]/activate/route');
    const res = await POST(makeRequest('/api/use-cases/abc/activate', { method: 'POST' }), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(404);
  });
});

describe('RBAC — admin/manager only', () => {
  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/use-cases/route');
    const res = await GET(makeRequest('/api/use-cases'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { GET } = await import('../app/api/use-cases/route');
    const res = await GET(makeRequest('/api/use-cases'));
    expect(res.status).toBe(403);
  });

  it('allows manager role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1' };
    const { GET } = await import('../app/api/use-cases/route');
    const res = await GET(makeRequest('/api/use-cases'));
    expect(res.status).toBe(200);
  });
});

describe('CRUD', () => {
  it('POST creates a use case with createdBy from session, guided defaults', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(jsonRequest('/api/use-cases', 'POST', {
      title: 'Draft weekly status reports',
      description: 'Summarise ticket progress',
      departments: ['Engineering'],
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('Draft weekly status reports');
    expect(body.createdBy).toBe('admin-1');
    expect(body.origin).toBe('planned');
    expect(body.status).toBe('confirmed');
    expect(body.captureMethod).toBe('guided');
    expect(body.departments).toEqual(['Engineering']);
  });

  it('POST returns 400 when title is missing', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(jsonRequest('/api/use-cases', 'POST', { description: 'no title' }));
    expect(res.status).toBe(400);
  });

  it('POST returns 400 for an invalid origin', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(jsonRequest('/api/use-cases', 'POST', { title: 'X', origin: 'bogus' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid origin');
  });

  it('POST returns 400 for an invalid status', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(jsonRequest('/api/use-cases', 'POST', { title: 'X', status: 'bogus' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid status');
  });

  it('GET lists use cases, newest first, with status/origin filters', async () => {
    await enableUseCases();
    const { POST, GET } = await import('../app/api/use-cases/route');
    await POST(jsonRequest('/api/use-cases', 'POST', { title: 'A', status: 'candidate' }));
    await POST(jsonRequest('/api/use-cases', 'POST', { title: 'B', status: 'confirmed', origin: 'emergent' }));

    const all = await (await GET(makeRequest('/api/use-cases'))).json();
    expect(all.length).toBe(2);

    const confirmedOnly = await (await GET(makeRequest('/api/use-cases?status=confirmed'))).json();
    expect(confirmedOnly.length).toBe(1);
    expect(confirmedOnly[0].title).toBe('B');

    const emergentOnly = await (await GET(makeRequest('/api/use-cases?origin=emergent'))).json();
    expect(emergentOnly.length).toBe(1);
    expect(emergentOnly[0].title).toBe('B');
  });

  it('GET /[id] returns the use case, 404 if missing', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Detail me' }))).json();

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const found = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(found.status).toBe(200);
    expect((await found.json()).title).toBe('Detail me');

    const missing = await GET(makeRequest('/api/use-cases/does-not-exist'), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(missing.status).toBe(404);
  });

  it('PATCH edits fields and confirms a status transition candidate -> confirmed', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Candidate use case', status: 'candidate' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { status: 'confirmed', title: 'Confirmed use case' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('confirmed');
    expect(updated.title).toBe('Confirmed use case');
  });

  it('PATCH returns 400 when title is set to null', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Has a title' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { title: null }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('title cannot be empty');
  });

  it('PATCH returns 400 when title is set to an empty/whitespace string', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Has a title' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { title: '   ' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('title cannot be empty');
  });

  it('PATCH returns 400 for an invalid origin', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'X' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { origin: 'bogus' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid origin');
  });

  it('PATCH returns 400 for an invalid status', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'X' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { status: 'bogus' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid status');
  });

  it('PATCH returns 404 for a missing id', async () => {
    await enableUseCases();
    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest('/api/use-cases/does-not-exist', 'PATCH', { status: 'confirmed' }), {
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the use case', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'To delete' }))).json();

    const { DELETE, GET } = await import('../app/api/use-cases/[id]/route');
    const res = await DELETE(makeRequest(`/api/use-cases/${created.id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);

    const found = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(found.status).toBe(404);
  });

  it('DELETE returns 404 for a missing id', async () => {
    await enableUseCases();
    const { DELETE } = await import('../app/api/use-cases/[id]/route');
    const res = await DELETE(makeRequest('/api/use-cases/does-not-exist', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /[id] includes weeks: ascending completed weeks + current week', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Tracked use case' }))).json();

    const { recordWeekMatches } = await import('@/lib/usecases/weeks');
    const { weekStart } = await import('@/lib/pulse/period');
    const nowS = Math.floor(Date.now() / 1000);
    const thisWeek = weekStart(nowS);
    const lastWeek = thisWeek - 7 * 86400;

    await recordWeekMatches(created.id, lastWeek, [
      { userId: 'user-1', sessionId: 'sess-1', occurredAt: lastWeek + 100, isMessage: true, tier: 2 },
    ]);
    await recordWeekMatches(created.id, thisWeek, [
      { userId: 'user-2', sessionId: 'sess-2', occurredAt: nowS, isMessage: true, tier: 3 },
    ]);

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.weeks)).toBe(true);
    expect(body.weeks.length).toBe(2);
    // ascending: completed week first, current week last
    expect(body.weeks[0].weekStart).toBe(lastWeek);
    expect(body.weeks[0].distinctUsers).toBe(1);
    expect(body.weeks[1].weekStart).toBe(thisWeek);
  });

  it('GET /[id] computes liveEvidence from the judged sessions without a prior POST /activate call', async () => {
    await enableUseCases();
    const now = Math.floor(Date.now() / 1000);
    const { POST: createUC } = await import('../app/api/use-cases/route');
    const created = await (await createUC(jsonRequest('/api/use-cases', 'POST', { title: 'Live evidence use case' }))).json();
    await seedJudgedSession(created.id, 'sess-live-1', 'user-1', now - 60);

    // Deliberately no POST /activate here — activateResult/lastActivatedAt stay null.
    expect(created.activateResult).toBeNull();
    expect(created.lastActivatedAt).toBeNull();

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveEvidence).toMatchObject({ seen: true, signals: ['work'], distinctUsers: 1, sessionCount: 1, matchedMessages: 2 });
    // The stored snapshot fields are untouched by a GET.
    expect(body.activateResult).toBeNull();
    expect(body.lastActivatedAt).toBeNull();
  });

  it('GET /[id] returns not-seen evidence (never an error) for a use case with no clues and no activity', async () => {
    await enableUseCases();
    const { POST: createUC } = await import('../app/api/use-cases/route');
    const created = await (await createUC(jsonRequest('/api/use-cases', 'POST', { title: 'No signals yet' }))).json();

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveEvidence).toMatchObject({ seen: false, sessionCount: 0 });
  });

  it('PATCH accepts ownerUserId', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Needs an owner' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { ownerUserId: 'user-42' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.ownerUserId).toBe('user-42');
  });

  it('PATCH archives and un-archives a use case', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Archive me' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const archived = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { status: 'archived' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe('archived');

    const restored = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { status: 'confirmed' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()).status).toBe('confirmed');
  });

  it('PATCH coerces strategic to a numeric 0|1 (route handler, not the queries layer)', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Strategic flag route test', status: 'confirmed' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');

    const truthy = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { strategic: true }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(truthy.status).toBe(200);
    const truthyBody = await truthy.json();
    expect(truthyBody.strategic).toBe(1);
    expect(typeof truthyBody.strategic).toBe('number');

    const falsy = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { strategic: false }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(falsy.status).toBe(200);
    const falsyBody = await falsy.json();
    expect(falsyBody.strategic).toBe(0);
    expect(typeof falsyBody.strategic).toBe('number');

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const persisted = await (await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) })).json();
    expect(persisted.strategic).toBe(0);
    expect(typeof persisted.strategic).toBe('number');
  });

  it('PATCH silently strips a client-supplied lifecycle field', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Lifecycle is tracker-owned' }))).json();
    expect(created.lifecycle).toBe('not_seen');

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', {
      lifecycle: 'adopted',
      lifecycleChangedAt: 12345,
      title: 'Still not client-settable',
    }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.lifecycle).toBe('not_seen');
    expect(updated.lifecycleChangedAt).toBe(created.lifecycleChangedAt);
    expect(updated.title).toBe('Still not client-settable');
  });

  it('PATCH re-checks the last 7 days when the matching rule changes (keywords)', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Rule change UC', keywords: ['old'] }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { keywords: ['new', 'rule'] }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect(bootstrapUseCaseMock).toHaveBeenCalledTimes(1);
    expect(bootstrapUseCaseMock).toHaveBeenCalledWith(created.id);
  });

  it('PATCH re-checks the last 7 days when the matching rule changes (skills/connectors/taskTypes/surfaces/departments)', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const { PATCH } = await import('../app/api/use-cases/[id]/route');

    const cases: Array<Record<string, unknown>> = [
      { skills: ['new-skill'] },
      { connectors: ['new-connector'] },
      { taskTypes: ['new-task-type'] },
      { surfaces: ['code'] },
      { departments: ['Engineering'] },
    ];

    for (const patchBody of cases) {
      bootstrapUseCaseMock.mockClear();
      const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Rule field UC' }))).json();
      const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', patchBody), {
        params: Promise.resolve({ id: created.id }),
      });
      expect(res.status).toBe(200);
      expect(bootstrapUseCaseMock).toHaveBeenCalledTimes(1);
      expect(bootstrapUseCaseMock).toHaveBeenCalledWith(created.id);
    }
  });

  it('PATCH asks for a re-check when what the work is changes (title, description, status), since sessions are judged against it', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    for (const patchBody of [{ title: 'Renamed' }, { description: 'Now about the board pack' }, { status: 'confirmed' }]) {
      bootstrapUseCaseMock.mockClear();
      const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Text change UC', status: 'candidate' }))).json();
      const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', patchBody), { params: Promise.resolve({ id: created.id }) });
      expect(res.status).toBe(200);
      expect(bootstrapUseCaseMock).toHaveBeenCalledTimes(1);
    }
  });

  it('POST refuses a use case without a description', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const res = await POST(new NextRequest('http://localhost/api/use-cases', {
      method: 'POST', body: JSON.stringify({ title: 'No description' }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/description is required/);
  });

  it('PATCH does NOT re-check when only strategic/owner change', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', {
      title: 'No rule change UC', status: 'candidate', keywords: ['stable'],
    }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', {
      strategic: true, ownerUserId: 'user-9',
    }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect(bootstrapUseCaseMock).not.toHaveBeenCalled();
  });

  it('PATCH does NOT re-check when a rule field is set to the same value it already had', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Unchanged rule UC', keywords: ['same', 'order'] }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { keywords: ['same', 'order'] }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect(bootstrapUseCaseMock).not.toHaveBeenCalled();
  });

  it('PATCH round-trips the four canvas fields (painPoint/valueHypothesis/baselineNote/kpiNote), slicing to 500 chars', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Canvas UC' }))).json();
    expect(created.painPoint).toBeNull();
    expect(created.valueHypothesis).toBeNull();
    expect(created.baselineNote).toBeNull();
    expect(created.kpiNote).toBeNull();

    const long = 'x'.repeat(600);
    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', {
      painPoint: 'Manual reconciliation takes two days each month',
      valueHypothesis: 'Automating the match cuts that to hours',
      baselineNote: 'Currently 16 hours of analyst time per close',
      kpiNote: long,
    }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.painPoint).toBe('Manual reconciliation takes two days each month');
    expect(updated.valueHypothesis).toBe('Automating the match cuts that to hours');
    expect(updated.baselineNote).toBe('Currently 16 hours of analyst time per close');
    expect(updated.kpiNote).toBe(long.slice(0, 500));
    expect(updated.kpiNote.length).toBe(500);

    // Null clears a previously-set canvas field.
    const cleared = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', { painPoint: null }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).painPoint).toBeNull();
  });

  it('PATCH with only canvas fields does NOT fire the matching-rule re-check', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', {
      title: 'Canvas-only UC', keywords: ['stable'],
    }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    const res = await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', {
      painPoint: 'Some pain', valueHypothesis: 'Some value', baselineNote: 'Some baseline', kpiNote: 'Some KPI',
    }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect(bootstrapUseCaseMock).not.toHaveBeenCalled();
  });

  it('GET /[id] returns the four canvas fields', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');
    const created = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Canvas GET UC' }))).json();

    const { PATCH } = await import('../app/api/use-cases/[id]/route');
    await PATCH(jsonRequest(`/api/use-cases/${created.id}`, 'PATCH', {
      painPoint: 'Pain', valueHypothesis: 'Value', baselineNote: 'Baseline', kpiNote: 'KPI',
    }), {
      params: Promise.resolve({ id: created.id }),
    });

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.painPoint).toBe('Pain');
    expect(body.valueHypothesis).toBe('Value');
    expect(body.baselineNote).toBe('Baseline');
    expect(body.kpiNote).toBe('KPI');
  });
});

describe('POST /api/use-cases/[id]/activate', () => {
  it('returns 404 when the use case is missing', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/[id]/activate/route');
    const res = await POST(makeRequest('/api/use-cases/does-not-exist/activate', { method: 'POST' }), {
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('persists not-seen evidence for a use case with no clues (no matching rule is needed any more)', async () => {
    await enableUseCases();
    const { POST: createUC } = await import('../app/api/use-cases/route');
    const created = await (await createUC(jsonRequest('/api/use-cases', 'POST', { title: 'No signals' }))).json();

    const { POST } = await import('../app/api/use-cases/[id]/activate/route');
    const res = await POST(makeRequest(`/api/use-cases/${created.id}/activate`, { method: 'POST' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).evidence.seen).toBe(false);
  });

  it('persists evidence from the judged sessions, leaving status untouched', async () => {
    await enableUseCases();
    const now = Math.floor(Date.now() / 1000);
    const { POST: createUC } = await import('../app/api/use-cases/route');
    const created = await (await createUC(jsonRequest('/api/use-cases', 'POST', { title: 'Contract review' }))).json();
    await seedJudgedSession(created.id, 'sess-1', 'user-1', now - 60);

    const { POST } = await import('../app/api/use-cases/[id]/activate/route');
    const res = await POST(makeRequest(`/api/use-cases/${created.id}/activate`, { method: 'POST' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBeUndefined();
    expect(body.evidence.seen).toBe(true);
    expect(body.evidence.signals).toEqual(['work']);

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const persisted = await (await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) })).json();
    expect(persisted.status).toBe(created.status);
    expect(persisted.lastActivatedAt).toBeGreaterThan(0);
    expect(persisted.activateResult.seen).toBe(true);
  });

  it('persists evidence when no telemetry matches the rule, leaving status untouched', async () => {
    await enableUseCases();
    const { POST: createUC } = await import('../app/api/use-cases/route');
    const created = await (await createUC(jsonRequest('/api/use-cases', 'POST', {
      title: 'Unseen use case',
      keywords: ['nonexistent-keyword-xyz'],
    }))).json();

    const { POST } = await import('../app/api/use-cases/[id]/activate/route');
    const res = await POST(makeRequest(`/api/use-cases/${created.id}/activate`, { method: 'POST' }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBeUndefined();
    expect(body.evidence.seen).toBe(false);

    const { GET } = await import('../app/api/use-cases/[id]/route');
    const persisted = await (await GET(makeRequest(`/api/use-cases/${created.id}`), { params: Promise.resolve({ id: created.id }) })).json();
    expect(persisted.status).toBe(created.status);
    expect(persisted.activateResult.seen).toBe(false);
  });
});

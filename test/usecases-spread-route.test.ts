// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level test for GET /api/use-cases/[id] gaining an additive `spread` field.
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

function makeRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function seedUser(id: string, dept: string | null, deactivated = false) {
  await sql.run(`INSERT INTO users (id, email, display_name, department, deactivated_at)
              VALUES (?, ?, ?, ?, ?)`,
    [id, `${id}@t.local`, id.toUpperCase(), dept, deactivated ? NOW : null]);
}
/** n sessions judged to be the use case's work, in the last completed week. */
async function seedJudgedSessions(ucId: string, userId: string, n: number) {
  const { weekStart } = await import('@/lib/pulse/period');
  const wk = weekStart(NOW) - 7 * DAY;
  for (let i = 0; i < n; i++) {
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, ?, ?)`, [ucId, wk, userId, `${userId}-s${i}`]);
  }
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.resetModules();
  await sql.exec(`DELETE FROM use_case_week_matches; DELETE FROM use_case_skill_drafts; DELETE FROM use_cases; DELETE FROM config;
           DELETE FROM pulse_classifications; DELETE FROM cowork_skill_invocations;
           DELETE FROM cowork_mcp_invocations; DELETE FROM cowork_messages; DELETE FROM users;`);
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

describe('GET /api/use-cases/[id] — spread field', () => {
  it('confirmed use case with its own skill: spread lists the person doing the work regularly who never ran it; weeks still present', async () => {
    await enableUseCases();
    await seedUser('anna', 'Finance'); // 4 judged sessions, never ran the skill -> listed
    await seedUser('ben', 'Finance');  // 1 judged session -> below the bar

    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Board-Pack Prep', description: 'Finance work.', status: 'confirmed', departments: ['Finance'] });
    await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, model, generated_at, downloaded_at)
      VALUES (?, 'board-pack-prep', 'd', 'b', '[]', '{}', '{}', 'm', ?, ?)`, [uc.id, NOW, NOW]);
    await seedJudgedSessions(uc.id, 'anna', 4);
    await seedJudgedSessions(uc.id, 'ben', 1);

    const { GET } = await import('@/app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${uc.id}`), { params: Promise.resolve({ id: uc.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spread.departments[0].users.map((u: { userId: string }) => u.userId)).toEqual(['anna']);
    expect(Array.isArray(body.weeks)).toBe(true);
  });

  it('confirmed use case without a skill: spread says how it starts', async () => {
    await enableUseCases();
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'No skill yet', description: 'Work.', status: 'confirmed', departments: ['Finance'] });
    const { GET } = await import('@/app/api/use-cases/[id]/route');
    const body = await (await GET(makeRequest(`/api/use-cases/${uc.id}`), { params: Promise.resolve({ id: uc.id }) })).json();
    expect(body.spread).toEqual({ unsupported: 'no_skill' });
  });

  it('a candidate-status use case gets spread: null', async () => {
    await enableUseCases();

    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Cand', status: 'candidate', taskTypes: ['t'] });

    const { GET } = await import('@/app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${uc.id}`), { params: Promise.resolve({ id: uc.id }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.spread).toBeNull();
  });
});

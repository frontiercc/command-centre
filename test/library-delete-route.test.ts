// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// S&C Board delete + the additive `codified` field on the
// Board detail GET. Runs on Postgres via createTestDatabase, session mocked at the auth
// boundary (same harness as test/use-cases-skill-draft-routes.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql; let cleanup: () => Promise<void>;
let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null };
const logAccess = vi.fn();
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
  canAccessOrgOverview: (role?: string) => role === 'admin' || role === 'manager' || role === 'viewer',
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: (...args: unknown[]) => logAccess(...args) }));

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, init as never);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => { const t = await createTestDatabase(); sql = t.sql; cleanup = t.cleanup; });
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_skill_drafts; DELETE FROM skill_library_votes; DELETE FROM skill_library_entries;
           DELETE FROM use_case_week_matches; DELETE FROM use_case_activation_weeks; DELETE FROM use_cases; DELETE FROM users; DELETE FROM config;`);
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  logAccess.mockClear();
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
});

async function seedEntry(name: string, published = 1): Promise<number> {
  await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, created_at, updated_at) VALUES (?, 'skill', 'cowork', 'org', ?, ?, ?)`, [name, published, NOW, NOW]);
  return Number(((await sql.get(`SELECT id FROM skill_library_entries WHERE name = ?`, [name])) as { id: number }).id);
}

async function seedCodified() {
  const { createUseCase } = await import('@/lib/usecases/queries');
  const uc = await createUseCase({ title: 'Month-end variance commentary', status: 'confirmed', skills: ['anthropic-skills:xlsx', 'month-end-variance-commentary'] });
  const entryId = await seedEntry('month-end-variance-commentary');
  await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, thin, model, generated_at, edited_at, downloaded_at, library_entry_id)
              VALUES (?, ?, 'd', '## Purpose', '[]', '{}', '{}', 0, 'm', ?, NULL, ?, ?)`, [uc.id, 'month-end-variance-commentary', NOW, NOW, entryId]);
  return { uc, entryId };
}

describe('GET /api/library/[id] codified field', () => {
  it('is null for an ordinary entry and names the use case for a codified skill', async () => {
    const { GET } = await import('@/app/api/library/[id]/route');
    const plain = await seedEntry('plain-skill');
    const r1 = await GET(req(`/api/library/${plain}`), params(String(plain)));
    expect(r1.status).toBe(200);
    expect((await r1.json()).codified).toBeNull();

    const { uc, entryId } = await seedCodified();
    const r2 = await GET(req(`/api/library/${entryId}`), params(String(entryId)));
    expect(r2.status).toBe(200);
    expect((await r2.json()).codified).toEqual({ useCaseId: uc.id, useCaseTitle: 'Month-end variance commentary' });
  });
});

describe('DELETE /api/library/[id]', () => {
  it('refuses anyone below manager and leaves the entry in place', async () => {
    const { DELETE } = await import('@/app/api/library/[id]/route');
    const id = await seedEntry('plain-skill');
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v-1', email: 'v@example.com' };
    const res = await DELETE(req(`/api/library/${id}`, { method: 'DELETE' }), params(String(id)));
    expect(res.status).toBe(403);
    expect(await sql.get(`SELECT COUNT(*) AS c FROM skill_library_entries WHERE id = ?`, [id])).toEqual({ c: 1 });
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ resource: 'library', action: 'DELETE', outcome: 'denied' }));
  });

  it('401s when not signed in and 404s an unknown id', async () => {
    const { DELETE } = await import('@/app/api/library/[id]/route');
    sessionResult = { authenticated: false };
    expect((await DELETE(req('/api/library/1', { method: 'DELETE' }), params('1'))).status).toBe(401);
    sessionResult = { authenticated: true, role: 'manager', userId: 'm-1', email: 'm@example.com' };
    expect((await DELETE(req('/api/library/99999', { method: 'DELETE' }), params('99999'))).status).toBe(404);
  });

  it('deletes an ordinary entry and its votes', async () => {
    const { DELETE } = await import('@/app/api/library/[id]/route');
    const id = await seedEntry('plain-skill');
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u1', 'u1@x.test', 'u1', 'otel', 1, 1)`);
    await sql.run(`INSERT INTO skill_library_votes (entry_id, voter_user_id, voted_at) VALUES (?, 'u1', ?)`, [id, NOW]);
    sessionResult = { authenticated: true, role: 'manager', userId: 'm-1', email: 'm@example.com' };
    const res = await DELETE(req(`/api/library/${id}`, { method: 'DELETE' }), params(String(id)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id, name: 'plain-skill', codified: null });
    expect(await sql.get(`SELECT COUNT(*) AS c FROM skill_library_entries WHERE id = ?`, [id])).toEqual({ c: 0 });
    expect(await sql.get(`SELECT COUNT(*) AS c FROM skill_library_votes WHERE entry_id = ?`, [id])).toEqual({ c: 0 });
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ resource: 'library', action: 'DELETE', outcome: 'success' }));
  });

  it('un-codifies a skill: rule trimmed, draft back to not-downloaded, draft text kept, entry gone', async () => {
    const { DELETE } = await import('@/app/api/library/[id]/route');
    const { uc, entryId } = await seedCodified();
    const res = await DELETE(req(`/api/library/${entryId}`, { method: 'DELETE' }), params(String(entryId)));
    expect(res.status).toBe(200);
    expect((await res.json()).codified).toEqual({ useCaseId: uc.id });

    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))!.skills).toEqual(['anthropic-skills:xlsx']);

    const draft = (await sql.get(`SELECT skill_name, downloaded_at, library_entry_id FROM use_case_skill_drafts WHERE use_case_id = ?`, [uc.id])) as { skill_name: string; downloaded_at: number | null; library_entry_id: number | null };
    expect(draft).toEqual({ skill_name: 'month-end-variance-commentary', downloaded_at: null, library_entry_id: null });
    expect(await sql.get(`SELECT COUNT(*) AS c FROM skill_library_entries WHERE id = ?`, [entryId])).toEqual({ c: 0 });

    // The use case page's own Discard is allowed again (it 409s only while downloaded_at is set).
    const { DELETE: discard } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const d = await discard(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'DELETE' }), params(uc.id));
    expect(d.status).toBe(200);
  });
});

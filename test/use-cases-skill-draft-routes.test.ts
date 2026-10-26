// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const DAY = 86400;
let sql: TestSql; let cleanup: () => Promise<void>;
let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));
vi.mock('@/lib/usecases/tracker', async (orig) => ({ ...(await orig<typeof import('@/lib/usecases/tracker')>()), bootstrapUseCase: vi.fn(async () => undefined) }));
vi.mock('@/lib/usecases/skill-draft', async (orig) => {
  const m = await orig<typeof import('@/lib/usecases/skill-draft')>();
  return { ...m, listKnownSystemNames: vi.fn(m.listKnownSystemNames) };
});

// The model call is injected at the service boundary: the route reads
// `globalThis.__cccSkillDraftCallModel` when set (test-only hook, see route).
const goodDraftJson = () => JSON.stringify({
  name: 'month-end-variance-commentary',
  description: 'Drafts board-pack variance commentary. Use when asked for month-end variance commentary.',
  body: ['## Purpose', '## What to ask for before starting', '## Steps', '## Output format', '## Quality rules', '## Edge cases', '## Not part of this skill']
    .map(h => `${h}\nOne paragraph per line. Tie revenue to Salesforce first.`).join('\n\n'),
  ownerQuestions: ['Threshold either/or?'],
  citations: { 'Purpose': [0], 'When to use this skill': [0], 'What to ask for before starting': [0], 'Steps': [0, 1], 'Output format': [1], 'Quality rules': [1], 'Edge cases': [2], 'Not part of this skill': [0] },
  excludedExcerpts: [],
});

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, init as never);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => { const t = await createTestDatabase(); sql = t.sql; cleanup = t.cleanup; });
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_skill_drafts; DELETE FROM use_case_week_matches; DELETE FROM use_case_activation_weeks; DELETE FROM use_cases;
           DELETE FROM cowork_messages; DELETE FROM cowork_skill_invocations; DELETE FROM skill_library_entries; DELETE FROM users; DELETE FROM config;`);
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true', useCasesSuggestUseContent: 'true' });
  (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async () => goodDraftJson();
});

/** Three people, 12 distinct prompts over 4 days with 6 follow-ups — clears the default bar (incl. distinct prompts). */
async function seedReadyUseCase() {
  const { createUseCase } = await import('@/lib/usecases/queries');
  const uc = await createUseCase({ title: 'Month-end variance commentary', status: 'confirmed', departments: ['Finance'] });
  const { weekStart } = await import('@/lib/pulse/period');
  const nowS = Math.floor(Date.now() / 1000);
  const ins = (...a: unknown[]) => sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, content_preview, content_full, source) VALUES (?,?,?,?,?,?,?,?,?)`, a);
  const wm = (...a: unknown[]) => sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, a);
  const u = (...a: unknown[]) => sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)`, a);
  let n = 0;
  for (const [ui, user] of ['ua', 'ub', 'uc'].entries()) {
    await u(user, `${user}@x.test`, user, 'otel', 1, nowS);
    for (let d = 0; d < 4; d++) {
      if (ui > 0 && d > 0) continue; // ua: 4 sessions; ub, uc: 1 each → 6 sessions
      const at = nowS - (2 + d * 7) * DAY;
      const sid = `s-${user}-${d}`;
      await ins(`m${n++}`, sid, user, 'cowork_user_message', 'cowork', at, 'p', `draft the month-end variance commentary for ${user} period ${d} flag over 5% or 50k`, 'otel');
      await ins(`m${n++}`, sid, user, 'cowork_user_message', 'cowork', at + 60, 'p', `no - one paragraph per line, tie revenue to salesforce first (${user} ${d})`, 'otel');
      await wm(uc.id, weekStart(at), user, sid);
    }
  }
  return uc;
}

describe('GET /api/use-cases/[id]/skill-draft', () => {
  it('404s when the flag is off, 401 unauthenticated, 403 for pulse role, 409 for a candidate use case', async () => {
    const { GET } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const { createUseCase } = await import('@/lib/usecases/queries');
    const cand = await createUseCase({ title: 'Cand', status: 'candidate' });
    expect((await GET(req(`/api/use-cases/${cand.id}/skill-draft`), params(cand.id))).status).toBe(409);
    sessionResult = { authenticated: true, role: 'pulse' };
    expect((await GET(req(`/api/use-cases/${cand.id}/skill-draft`), params(cand.id))).status).toBe(403);
    sessionResult = { authenticated: false };
    expect((await GET(req(`/api/use-cases/${cand.id}/skill-draft`), params(cand.id))).status).toBe(401);
    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ useCasesEnabled: 'false' });
    sessionResult = { authenticated: true, role: 'admin' };
    expect((await GET(req(`/api/use-cases/${cand.id}/skill-draft`), params(cand.id))).status).toBe(404);
  });

  it('returns readiness with the missing counts when not ready, and the detail GET carries the same view', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Thin', status: 'confirmed' });
    const { GET } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const body = await (await GET(req(`/api/use-cases/${uc.id}/skill-draft`), params(uc.id))).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.missing.map((m: { key: string }) => m.key)).toEqual(['people', 'days', 'prompts', 'followUps']);
    expect(body.contentOn).toBe(true);
    expect(body.draft).toBeNull();

    const detail = await import('@/app/api/use-cases/[id]/route');
    const d = await (await detail.GET(req(`/api/use-cases/${uc.id}`), params(uc.id))).json();
    expect(d.skillDraft.readiness.ready).toBe(false);
    expect(d.impact).toBeDefined(); // pre-existing fields untouched
  });
});

describe('POST /api/use-cases/[id]/skill-draft', () => {
  it('409 not_ready with missing, 409 content_off, then 200 with a stored draft when ready', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const { createUseCase } = await import('@/lib/usecases/queries');
    const thin = await createUseCase({ title: 'Thin', status: 'confirmed' });
    const r1 = await POST(req(`/api/use-cases/${thin.id}/skill-draft`, { method: 'POST' }), params(thin.id));
    expect(r1.status).toBe(409);
    expect((await r1.json())).toMatchObject({ error: 'not_ready' });

    const uc = await seedReadyUseCase();
    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ useCasesSuggestUseContent: 'false' });
    const r2 = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(await r2.json()).toEqual({ error: 'content_off' });
    await saveConfig({ useCasesSuggestUseContent: 'true' });

    const r3 = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r3.status).toBe(200);
    const body = await r3.json();
    expect(body.draft.skillName).toBe('month-end-variance-commentary');
    expect(body.draft.corpusStats.people).toBe(3);
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 1 });
  });

  it('502 stores nothing when the model output fails validation; 409 edited unless ?replace=1', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const uc = await seedReadyUseCase();
    (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async () => goodDraftJson().replace('Salesforce first', 'Jira first, $50k');
    const bad = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(bad.status).toBe(502);
    expect((await bad.json()).reasons.length).toBeGreaterThan(0);
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 0 });

    (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async () => goodDraftJson();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    const p = await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ description: 'Edited by the owner.' }) }), params(uc.id));
    expect(p.status).toBe(200);
    const { logAccess } = await import('@/lib/audit/log');
    vi.mocked(logAccess).mockClear();
    expect((await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id))).status).toBe(409);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', detail: expect.stringContaining('edited') }));
    expect((await POST(req(`/api/use-cases/${uc.id}/skill-draft?replace=1`, { method: 'POST' }), params(uc.id))).status).toBe(200);
  });

  it('a model call that throws is 502 model_unavailable (not a failed check), audited as a failure, nothing stored', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const uc = await seedReadyUseCase();
    (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async () => { throw new Error('No AI API key configured'); };
    const { logAccess } = await import('@/lib/audit/log');
    vi.mocked(logAccess).mockClear();
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'model_unavailable' });
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 0 });
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: expect.stringContaining('No AI API key configured') }));
  });
});

describe('PATCH + zip', () => {
  it('rejects a bad name (400), a name claimed on the Board by someone else (409); zip streams, applies first-download effects once, and rename after download updates rule + Board', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));

    expect((await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'Bad Name' }) }), params(uc.id))).status).toBe(400);
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, created_at, updated_at) VALUES ('taken','skill','cowork','org',1,'ua',1,1)`);
    expect((await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'taken' }) }), params(uc.id))).status).toBe(409);

    const z1 = await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));
    expect(z1.status).toBe(200);
    expect(z1.headers.get('content-type')).toBe('application/zip');
    expect(z1.headers.get('content-disposition')).toContain('month-end-variance-commentary.zip');
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toContain('month-end-variance-commentary');
    expect(await sql.get(`SELECT is_published, department FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ is_published: 1, department: 'Finance' });

    await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries`)).toEqual({ n: 2 }); // 'taken' + ours, no duplicate

    const ren = await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'variance-commentary' }) }), params(uc.id));
    expect(ren.status).toBe(200);
    expect((await getUseCase(uc.id))?.skills).toEqual(['variance-commentary']);
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'variance-commentary'`)).toEqual({ n: 1 });
  });
});

describe('Task 9 review decisions', () => {
  const setModel = (fn: () => Promise<string>) => { (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = fn; };

  it('POST suffixes a generated name already claimed on the Board by someone else', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const uc = await seedReadyUseCase();
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, created_at, updated_at) VALUES ('month-end-variance-commentary','skill','cowork','org',1,'ub',1,1)`);
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(200);
    expect((await r.json()).draft.skillName).toBe('month-end-variance-commentary-2');
    expect(await sql.get('SELECT skill_name FROM use_case_skill_drafts')).toEqual({ skill_name: 'month-end-variance-commentary-2' });
  });

  it('POST suffixes a generated name another use case\'s draft already holds', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const uc = await seedReadyUseCase();
    const { createUseCase } = await import('@/lib/usecases/queries');
    const other = await createUseCase({ title: 'Other', status: 'confirmed' });
    await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, thin, model, generated_at) VALUES (?, 'month-end-variance-commentary', 'd', 'b', '[]', '{}', '{}', 0, 'm', 1)`, [other.id]);
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect((await r.json()).draft.skillName).toBe('month-end-variance-commentary-2');
  });

  it('regenerate after download with a different name renames the rule entry and the Board row (same id)', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect((await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id))).status).toBe(200);
    const before = await sql.get(`SELECT id FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`) as { id: number };

    setModel(async () => goodDraftJson().replace('"month-end-variance-commentary"', '"board-variance-commentary"'));
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft?replace=1`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(200);
    expect((await r.json()).draft.skillName).toBe('board-variance-commentary');
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toEqual(['board-variance-commentary']);
    expect(await sql.get(`SELECT id FROM skill_library_entries WHERE name = 'board-variance-commentary'`)).toEqual({ id: before.id });
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ n: 0 });
  });

  it('PATCH description after download updates the Board entry description', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));
    const p = await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ description: 'Owner-edited description.' }) }), params(uc.id));
    expect(p.status).toBe(200);
    expect(await sql.get(`SELECT description FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ description: 'Owner-edited description.' });
  });

  it('zip returns 409 name_taken, with no rule or Board change, when the name is claimed by someone else after drafting', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, description, created_at, updated_at) VALUES ('month-end-variance-commentary','skill','cowork','org',1,'ub','theirs',1,1)`);
    const z = await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));
    expect(z.status).toBe(409);
    expect(await z.json()).toEqual({ error: 'name_taken' });
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toEqual([]);
    expect(await sql.get(`SELECT COUNT(*) AS n, MAX(description) AS d FROM skill_library_entries`)).toEqual({ n: 1, d: 'theirs' });
    expect(await sql.get('SELECT downloaded_at FROM use_case_skill_drafts')).toEqual({ downloaded_at: null });
  });

  it('POST still drafts when the known-systems lookup fails', async () => {
    const draftMod = await import('@/lib/usecases/skill-draft');
    vi.mocked(draftMod.listKnownSystemNames).mockRejectedValueOnce(new Error('db hiccup'));
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const uc = await seedReadyUseCase();
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(200);
  });
});

describe('Task 10 review fixes', () => {
  it('claim-on-download: an unclaimed Board entry with the drafted name is stored unsuffixed, then claimed by the zip download', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await sql.run(`INSERT INTO skill_library_entries (name) VALUES ('month-end-variance-commentary')`);

    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(200);
    expect((await r.json()).draft.skillName).toBe('month-end-variance-commentary');
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ n: 1 });

    const z = await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));
    expect(z.status).toBe(200);
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ n: 1 });
    expect(await sql.get(`SELECT is_published FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ is_published: 1 });
  });

  it('after download, an unclaimed name cannot be taken via PATCH (Board rename would collide), but a regenerated draft claiming it is suffixed and the Board row is renamed to the suffixed name', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));

    await sql.run(`INSERT INTO skill_library_entries (name) VALUES ('other-free-name')`);

    const p = await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'other-free-name' }) }), params(uc.id));
    expect(p.status).toBe(409);
    expect(await p.json()).toEqual({ error: 'name_taken' });

    (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async () => goodDraftJson().replace('"month-end-variance-commentary"', '"other-free-name"');
    const r = await POST(req(`/api/use-cases/${uc.id}/skill-draft?replace=1`, { method: 'POST' }), params(uc.id));
    expect(r.status).toBe(200);
    expect((await r.json()).draft.skillName).toBe('other-free-name-2');
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toEqual(['other-free-name-2']);
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'other-free-name-2'`)).toEqual({ n: 1 });
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'month-end-variance-commentary'`)).toEqual({ n: 0 });
  });
});

describe('Branch review #5: PATCH and zip refusals are audited; a failed rename after download still returns the stored draft', () => {
  it('PATCH 409 name_taken, 400 invalid and 404 no-draft, and zip 404 no-draft, each write a denied audit entry', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const { logAccess } = await import('@/lib/audit/log');
    const uc = await seedReadyUseCase();

    vi.mocked(logAccess).mockClear();
    expect((await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ description: 'x' }) }), params(uc.id))).status).toBe(404);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', detail: expect.stringContaining('no draft') }));
    vi.mocked(logAccess).mockClear();
    expect((await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id))).status).toBe(404);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', action: 'EXPORT', detail: expect.stringContaining('no draft') }));

    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    vi.mocked(logAccess).mockClear();
    expect((await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'Bad Name' }) }), params(uc.id))).status).toBe(400);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', detail: expect.stringContaining('invalid') }));

    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, created_at, updated_at) VALUES ('taken','skill','cowork','org',1,'ua',1,1)`);
    vi.mocked(logAccess).mockClear();
    expect((await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'taken' }) }), params(uc.id))).status).toBe(409);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', action: 'WRITE', detail: expect.stringContaining('name_taken') }));
  });

  it('DELETE discards a not-yet-downloaded draft, and refuses once it has been downloaded', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const { DELETE, GET } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const { logAccess } = await import('@/lib/audit/log');
    const uc = await seedReadyUseCase();

    // Not found before any draft exists.
    vi.mocked(logAccess).mockClear();
    expect((await DELETE(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'DELETE' }), params(uc.id))).status).toBe(404);
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', action: 'DELETE', detail: expect.stringContaining('no draft') }));

    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    vi.mocked(logAccess).mockClear();
    const d1 = await DELETE(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'DELETE' }), params(uc.id));
    expect(d1.status).toBe(200);
    expect(await d1.json()).toEqual({ ok: true });
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', action: 'DELETE' }));
    const afterDelete = await (await GET(req(`/api/use-cases/${uc.id}/skill-draft`), params(uc.id))).json();
    expect(afterDelete.draft).toBeNull();
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 0 });

    // Re-draft, download, then DELETE must refuse and leave the draft in place.
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect((await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id))).status).toBe(200);
    vi.mocked(logAccess).mockClear();
    const d2 = await DELETE(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'DELETE' }), params(uc.id));
    expect(d2.status).toBe(409);
    expect(await d2.json()).toEqual({ error: 'downloaded' });
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', action: 'DELETE', detail: expect.stringContaining('downloaded') }));
    expect(await sql.get('SELECT COUNT(*) AS n FROM use_case_skill_drafts')).toEqual({ n: 1 });
  });

  it('PATCH after download: a rename failure is audited as a failure and still returns 200 with the stored draft', async () => {
    const { POST, PATCH } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const zip = await import('@/app/api/use-cases/[id]/skill-draft/zip/route');
    const publish = await import('@/lib/usecases/skill-publish');
    const uc = await seedReadyUseCase();
    await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    await zip.GET(req(`/api/use-cases/${uc.id}/skill-draft/zip`), params(uc.id));

    const spy = vi.spyOn(publish, 'renameCodifiedSkill').mockRejectedValueOnce(new Error('unique race'));
    const { logAccess } = await import('@/lib/audit/log');
    vi.mocked(logAccess).mockClear();
    const r = await PATCH(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'PATCH', body: JSON.stringify({ skillName: 'renamed-skill' }) }), params(uc.id));
    expect(r.status).toBe(200);
    expect((await r.json()).draft.skillName).toBe('renamed-skill');
    expect(logAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: expect.stringContaining('unique race') }));
    spy.mockRestore();
  });
});

describe('POST /api/use-cases/[id]/skill-draft model selection', () => {
  it('drafts with skillDraftModel (default Sonnet 5), honouring an explicit choice; a blank save resolves to the default, never the Core AI model', async () => {
    const { POST } = await import('@/app/api/use-cases/[id]/skill-draft/route');
    const { saveConfig } = await import('@/lib/config');
    const uc = await seedReadyUseCase();
    const seen: string[] = [];
    (globalThis as Record<string, unknown>).__cccSkillDraftCallModel = async ({ model }: { model: string }) => { seen.push(model); return goodDraftJson(); };

    // Default: the capability's own model, not the Core AI model.
    const r1 = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r1.status).toBe(200);
    expect(seen.at(-1)).toBe('claude-sonnet-5');
    expect((await r1.json()).draft.model).toBe('claude-sonnet-5');

    // An explicit choice is honoured.
    await saveConfig({ skillDraftModel: 'claude-opus-5-5' });
    const r2 = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r2.status).toBe(200);
    expect(seen.at(-1)).toBe('claude-opus-5-5');

    // A blank save resolves to the key's default (config `resolve()` treats '' as unset), so
    // the capability never silently drops to the Core AI model.
    await saveConfig({ skillDraftModel: '' });
    const r3 = await POST(req(`/api/use-cases/${uc.id}/skill-draft`, { method: 'POST' }), params(uc.id));
    expect(r3.status).toBe(200);
    expect(seen.at(-1)).toBe('claude-sonnet-5');
  });
});

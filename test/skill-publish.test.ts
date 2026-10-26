// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/usecases/tracker', async (orig) => ({ ...(await orig<typeof import('@/lib/usecases/tracker')>()), bootstrapUseCase: vi.fn(async () => undefined) }));

const stats = { prompts: 19, distinctPrompts: 18, people: 3, sessions: 9, days: 9, followUps: 8, weeksSpanned: 10, unreadableSessions: 0, firstAt: 1, lastAt: 2 };

describe('skill publish', () => {
  let sql: TestSql; let cleanup: () => Promise<void>;
  beforeAll(async () => { const t = await createTestDatabase(); sql = t.sql; cleanup = t.cleanup; });
  afterAll(async () => cleanup());

  async function makeDraft(title: string, name: string) {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title, status: 'confirmed', departments: ['Finance'], skills: ['anthropic-skills:xlsx'] });
    const store = await import('@/lib/usecases/skill-draft-store');
    const draft = await store.upsertGeneratedDraft(uc.id, { name, description: 'Drafts commentary.', body: '## Purpose\nx', ownerQuestions: [], citations: {}, thin: false }, stats, 'm', 1000);
    return { uc, draft };
  }

  it('builds a zip with <name>/SKILL.md and spec frontmatter', async () => {
    const { uc, draft } = await makeDraft('Zip UC', 'zip-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    const fm = pub.buildFrontmatter(draft, 'Finance', uc.title);
    expect(fm).toMatch(/^---\nname: zip-uc\ndescription: "Drafts commentary."\nmetadata:\n  drafted-by: command-centre\n  department: Finance\n  source-process: "Zip UC"\n  status: draft-for-owner-review\n---$/);
    const buf = await pub.buildSkillZip(draft, 'Finance', uc.title);
    expect(buf.length).toBeGreaterThan(100);
    // Local file header: filename 'zip-uc/SKILL.md' appears in the archive bytes.
    expect(buf.toString('latin1')).toContain('zip-uc/SKILL.md');
  });

  it('first download adds the skill to the rule, creates a claimed Board entry with the actor resolved by email, and is idempotent', async () => {
    const { uc, draft } = await makeDraft('Publish UC', 'publish-uc');
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('users-row-1','sam@x.test','Sam','otel',1,2)`);
    const pub = await import('@/lib/usecases/skill-publish');
    const { bootstrapUseCase } = await import('@/lib/usecases/tracker');

    const r1 = await pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 5000);
    expect(r1.ruleUpdated).toBe(true);
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx', 'publish-uc']);
    expect(bootstrapUseCase).toHaveBeenCalledWith(uc.id);

    const entry = await sql.get(`SELECT * FROM skill_library_entries WHERE name = 'publish-uc'`) as Record<string, unknown>;
    expect(entry).toMatchObject({ type: 'skill', surface: 'cowork', source: 'org', is_published: 1, author_user_id: 'users-row-1', department: 'Finance', source_url: `/use-cases/${uc.id}` });
    expect(String(entry.install_guide)).toMatch(/Organisation settings/);
    expect(r1.libraryEntryId).toBe(entry.id);

    const { getSkillDraft } = await import('@/lib/usecases/skill-draft-store');
    expect((await getSkillDraft(uc.id))?.downloadedAt).toBe(5000);

    // Repeat download: the route re-reads both the use case and the draft, and a different admin may be downloading.
    const freshUc = (await getUseCase(uc.id))!;
    const freshDraft = (await getSkillDraft(uc.id))!;
    const r2 = await pub.applyFirstDownloadEffects(freshUc, freshDraft, { userId: 'admin-uuid-9', email: 'other-admin@x.test' }, 6000);
    expect(r2).toEqual({ libraryEntryId: r1.libraryEntryId, ruleUpdated: false });
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'publish-uc'`)).toEqual({ n: 1 });
    const after = await sql.get(`SELECT author_user_id, department, updated_at FROM skill_library_entries WHERE name = 'publish-uc'`);
    expect(after).toEqual({ author_user_id: 'users-row-1', department: 'Finance', updated_at: 5000 });
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx', 'publish-uc']);
    expect(bootstrapUseCase).toHaveBeenCalledTimes(1);
    expect((await getSkillDraft(uc.id))?.downloadedAt).toBe(5000);
    expect(await sql.get(`SELECT id FROM users WHERE id = 'admin-uuid-9'`)).toBeUndefined();
  });

  it('refuses a name claimed by someone else, with no writes at all', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('users-row-1','sam@x.test','Sam','otel',1,2) ON CONFLICT DO NOTHING`);
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, description, department, created_at, updated_at) VALUES ('foreign-uc','skill','cowork','org',1,'users-row-1','Someone else''s.','Legal',1,1)`);
    const before = await sql.get(`SELECT * FROM skill_library_entries WHERE name = 'foreign-uc'`);
    const { uc, draft } = await makeDraft('Foreign UC', 'foreign-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    const { bootstrapUseCase } = await import('@/lib/usecases/tracker');
    vi.mocked(bootstrapUseCase).mockClear();
    await expect(pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-3', email: 'third@x.test' }, 7500)).rejects.toBeInstanceOf(pub.BoardNameTakenError);
    const { getUseCase } = await import('@/lib/usecases/queries');
    const { getSkillDraft } = await import('@/lib/usecases/skill-draft-store');
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx']);
    expect(bootstrapUseCase).not.toHaveBeenCalled();
    const d = await getSkillDraft(uc.id);
    expect(d?.downloadedAt).toBeNull();
    expect(d?.libraryEntryId).toBeNull();
    expect(await sql.get(`SELECT * FROM skill_library_entries WHERE name = 'foreign-uc'`)).toEqual(before);
    expect(await sql.get(`SELECT id FROM users WHERE id = 'admin-uuid-3'`)).toBeUndefined();
  });

  it('renameCodifiedSkill does nothing before the first download', async () => {
    const { uc, draft } = await makeDraft('Early Rename UC', 'early-rename-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    const { bootstrapUseCase } = await import('@/lib/usecases/tracker');
    vi.mocked(bootstrapUseCase).mockClear();
    await pub.renameCodifiedSkill(uc, draft, 'early-rename-uc', 'other-name');
    const { getUseCase } = await import('@/lib/usecases/queries');
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx']);
    expect(bootstrapUseCase).not.toHaveBeenCalled();
  });

  it('claims an existing UNCLAIMED Board entry instead of duplicating, and inserts a users row when no email match exists', async () => {
    const { uc, draft } = await makeDraft('Claim UC', 'claim-uc');
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, created_at, updated_at) VALUES ('claim-uc','skill','cowork','org',0,1,1)`);
    const pub = await import('@/lib/usecases/skill-publish');
    await pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-2', email: 'new-admin@x.test' }, 7000);
    const rows = await sql.all(`SELECT is_published, author_user_id FROM skill_library_entries WHERE name = 'claim-uc'`) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ is_published: 1, author_user_id: 'admin-uuid-2' }]);
    expect(await sql.get(`SELECT email FROM users WHERE id = 'admin-uuid-2'`)).toEqual({ email: 'new-admin@x.test' });
  });

  it('boardNameConflict distinguishes none / unclaimed / own / other', async () => {
    const { uc } = await makeDraft('Conflict UC', 'conflict-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    expect(await pub.boardNameConflict('brand-new', uc.id)).toBe('none');
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, created_at, updated_at) VALUES ('free-one','skill','cowork','org',0,1,1)`);
    expect(await pub.boardNameConflict('free-one', uc.id)).toBe('unclaimed');
    await sql.run(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, created_at, updated_at) VALUES ('taken-one','skill','cowork','org',1,'users-row-1',1,1)`);
    expect(await pub.boardNameConflict('taken-one', uc.id)).toBe('other');
    const { getSkillDraft } = await import('@/lib/usecases/skill-draft-store');
    await pub.applyFirstDownloadEffects((await (await import('@/lib/usecases/queries')).getUseCase(uc.id))!, (await getSkillDraft(uc.id))!, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 8000);
    expect(await pub.boardNameConflict('conflict-uc', uc.id)).toBe('own');
  });

  it('renameCodifiedSkill swaps the rule entry and renames the Board entry', async () => {
    const { uc, draft } = await makeDraft('Rename UC', 'rename-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    await pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 9000);
    const { getUseCase } = await import('@/lib/usecases/queries');
    const { getSkillDraft } = await import('@/lib/usecases/skill-draft-store');
    await pub.renameCodifiedSkill((await getUseCase(uc.id))!, (await getSkillDraft(uc.id))!, 'rename-uc', 'renamed-uc');
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx', 'renamed-uc']);
    expect(await sql.get(`SELECT name FROM skill_library_entries WHERE id = ?`, [(await getSkillDraft(uc.id))!.libraryEntryId])).toEqual({ name: 'renamed-uc' });
  });

  it('download -> regenerate with the SAME name -> download again reuses the own Board entry', async () => {
    const { uc, draft } = await makeDraft('Regen Same UC', 'regen-same-uc');
    const pub = await import('@/lib/usecases/skill-publish');
    const store = await import('@/lib/usecases/skill-draft-store');
    const { getUseCase } = await import('@/lib/usecases/queries');
    const r1 = await pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 10000);
    await store.upsertGeneratedDraft(uc.id, { name: 'regen-same-uc', description: 'Regenerated.', body: '## Purpose\ny', ownerQuestions: [], citations: {}, thin: false }, stats, 'm', 10100);
    const freshDraft = (await store.getSkillDraft(uc.id))!;
    expect(freshDraft.libraryEntryId).toBe(r1.libraryEntryId);
    const r2 = await pub.applyFirstDownloadEffects((await getUseCase(uc.id))!, freshDraft, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 10200);
    expect(r2).toEqual({ libraryEntryId: r1.libraryEntryId, ruleUpdated: false });
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'regen-same-uc'`)).toEqual({ n: 1 });
    expect(await pub.boardNameConflict('regen-same-uc', uc.id)).toBe('own');
  });

  it('download -> regenerate with a DIFFERENT name -> rename keeps one Board entry under the new name', async () => {
    const { uc, draft } = await makeDraft('Regen Rename UC', 'regen-old-name');
    const pub = await import('@/lib/usecases/skill-publish');
    const store = await import('@/lib/usecases/skill-draft-store');
    const { getUseCase } = await import('@/lib/usecases/queries');
    const r1 = await pub.applyFirstDownloadEffects(uc, draft, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 11000);
    const before = (await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries`) as { n: number }).n;
    await store.upsertGeneratedDraft(uc.id, { name: 'regen-new-name', description: 'Regenerated.', body: '## Purpose\ny', ownerQuestions: [], citations: {}, thin: false }, stats, 'm', 11100);
    const freshDraft = (await store.getSkillDraft(uc.id))!;
    await pub.renameCodifiedSkill((await getUseCase(uc.id))!, freshDraft, 'regen-old-name', 'regen-new-name');
    expect((await getUseCase(uc.id))?.skills).toEqual(['anthropic-skills:xlsx', 'regen-new-name']);
    expect(await sql.get(`SELECT name FROM skill_library_entries WHERE id = ?`, [r1.libraryEntryId])).toEqual({ name: 'regen-new-name' });
    expect(await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries WHERE name = 'regen-old-name'`)).toEqual({ n: 0 });
    expect((await sql.get(`SELECT COUNT(*) AS n FROM skill_library_entries`) as { n: number }).n).toBe(before);
    expect(await pub.boardNameConflict('regen-new-name', uc.id)).toBe('own');
    // A later download is a no-op against the same entry.
    const r2 = await pub.applyFirstDownloadEffects((await getUseCase(uc.id))!, (await store.getSkillDraft(uc.id))!, { userId: 'admin-uuid-1', email: 'sam@x.test' }, 11200);
    expect(r2).toEqual({ libraryEntryId: r1.libraryEntryId, ruleUpdated: false });
  });
});

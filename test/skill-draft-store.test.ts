// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

const stats = { prompts: 19, distinctPrompts: 18, people: 3, sessions: 9, days: 9, followUps: 8, weeksSpanned: 10, unreadableSessions: 1, firstAt: 1, lastAt: 2 };
const draft = { name: 'month-end-variance-commentary', description: 'd', body: '## Purpose\nx', ownerQuestions: ['Q1', 'Q2'], citations: { Steps: [0, 1] }, thin: false };

describe('skill draft store', () => {
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDatabase(); cleanup = t.cleanup;
    // Board rows for the library_entry_id values below: Postgres enforces the
    // FK to skill_library_entries.
    // An id the migrations' seeded entries already hold is fine as it is.
    for (const id of [7, 8, 9, 11]) {
      await t.sql.run(`INSERT INTO skill_library_entries (id, name, type, surface, source, is_published, created_at, updated_at) VALUES (?, ?, 'skill', 'cowork', 'org', 1, 1, 1) ON CONFLICT DO NOTHING`, [id, `store-entry-${id}`]);
    }
  });
  afterAll(async () => cleanup());

  it('upserts, reads back typed, patches with edited_at, marks downloaded once, and finds by name', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Store UC', status: 'confirmed' });
    const store = await import('@/lib/usecases/skill-draft-store');

    expect(await store.getSkillDraft(uc.id)).toBeNull();

    const rec = await store.upsertGeneratedDraft(uc.id, draft, stats, 'claude-haiku-4-5-20251001', 1000);
    expect(rec).toMatchObject({ useCaseId: uc.id, skillName: draft.name, thin: false, generatedAt: 1000, editedAt: null, downloadedAt: null, libraryEntryId: null });
    expect(rec.ownerQuestions).toEqual([{ q: 'Q1', done: false }, { q: 'Q2', done: false }]);
    expect(rec.corpusStats).toEqual(stats);

    const patched = await store.patchSkillDraft(uc.id, { skillName: 'variance-commentary', ownerQuestions: [{ q: 'Q1', done: true }, { q: 'Q2', done: false }] }, 1100);
    expect(patched?.skillName).toBe('variance-commentary');
    expect(patched?.editedAt).toBe(1100);
    expect(patched?.ownerQuestions[0].done).toBe(true);

    await store.markDownloaded(uc.id, 7, 1200);
    await store.markDownloaded(uc.id, 8, 1300);                          // second call must not move it
    const after = await store.getSkillDraft(uc.id);
    expect(after?.downloadedAt).toBe(1200);
    expect(after?.libraryEntryId).toBe(7);

    expect((await store.findDraftBySkillName('variance-commentary'))?.useCaseId).toBe(uc.id);
    expect(await store.findDraftBySkillName('nope')).toBeNull();

    // Regenerate replaces the draft text and resets edited_at only; the Board link persists.
    const again = await store.upsertGeneratedDraft(uc.id, { ...draft, name: 'regenerated' }, stats, 'm2', 2000);
    expect(again).toMatchObject({ skillName: 'regenerated', editedAt: null, downloadedAt: 1200, libraryEntryId: 7, generatedAt: 2000, model: 'm2' });
  });

  it('markDownloaded re-stamps a null library_entry_id without moving downloaded_at', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Store UC 2', status: 'confirmed' });
    const store = await import('@/lib/usecases/skill-draft-store');
    await store.upsertGeneratedDraft(uc.id, { ...draft, name: 'relink-me' }, stats, 'm', 1000);
    await store.markDownloaded(uc.id, 7, 1200);
    // The Board row was deleted: FK ON DELETE SET NULL leaves downloaded_at set and the link null.
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const client = await getTypedClient();
    await client.update(schema.useCaseSkillDrafts).set({ library_entry_id: null } as never).where(eq(schema.useCaseSkillDrafts.use_case_id, uc.id));
    await store.markDownloaded(uc.id, 9, 1500);
    const after = await store.getSkillDraft(uc.id);
    expect(after?.downloadedAt).toBe(1200);
    expect(after?.libraryEntryId).toBe(9);
    await store.markDownloaded(uc.id, 11, 1600);                         // a set link is never moved either
    expect((await store.getSkillDraft(uc.id))?.libraryEntryId).toBe(9);
  });

  it('deleteSkillDraft removes the row', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Store UC 3', status: 'confirmed' });
    const store = await import('@/lib/usecases/skill-draft-store');
    await store.upsertGeneratedDraft(uc.id, { ...draft, name: 'discard-me' }, stats, 'm', 1000);
    expect(await store.getSkillDraft(uc.id)).not.toBeNull();
    await store.deleteSkillDraft(uc.id);
    expect(await store.getSkillDraft(uc.id)).toBeNull();
    await expect(store.deleteSkillDraft(uc.id)).resolves.toBeUndefined(); // idempotent
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * CRUD over use_case_skill_drafts — one current draft
 * per use case. Regenerate replaces the draft text and resets edited_at
 * only: downloaded_at and library_entry_id persist, because the Board link and
 * the fact that the use case has been codified belong to the use case, not to
 * the draft text (a regenerated name that differs from the downloaded one is a
 * rename, handled by the caller via renameCodifiedSkill). An owner edit sets
 * edited_at; the first download sets downloaded_at exactly once.
 * No user-identity columns here by design — who edited is in the access
 * audit log.
 */
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { SkillCorpusStats } from '@/lib/usecases/skill-readiness';
import type { ValidatedSkillDraft } from '@/lib/usecases/skill-draft-validate';

export interface OwnerQuestion { q: string; done: boolean }

export interface SkillDraftRecord {
  useCaseId: string;
  skillName: string;
  description: string;
  bodyMd: string;
  ownerQuestions: OwnerQuestion[];
  citations: Record<string, number[]>;
  corpusStats: SkillCorpusStats;
  thin: boolean;
  model: string;
  generatedAt: number;
  editedAt: number | null;
  downloadedAt: number | null;
  libraryEntryId: number | null;
}

interface Row {
  use_case_id: string; skill_name: string; description: string; body_md: string;
  owner_questions_json: string; citations_json: string; corpus_stats_json: string;
  thin: number | string; model: string; generated_at: number | string;
  edited_at: number | string | null; downloaded_at: number | string | null; library_entry_id: number | string | null;
}

function parse<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
function num(v: number | string | null): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toRecord(r: Row): SkillDraftRecord {
  return {
    useCaseId: r.use_case_id,
    skillName: r.skill_name,
    description: r.description,
    bodyMd: r.body_md,
    ownerQuestions: parse<OwnerQuestion[]>(r.owner_questions_json, []),
    citations: parse<Record<string, number[]>>(r.citations_json, {}),
    corpusStats: parse<SkillCorpusStats>(r.corpus_stats_json, { prompts: 0, distinctPrompts: 0, people: 0, sessions: 0, days: 0, followUps: 0, weeksSpanned: 0, unreadableSessions: 0, firstAt: null, lastAt: null }),
    thin: Number(r.thin) === 1,
    model: r.model,
    generatedAt: Number(r.generated_at),
    editedAt: num(r.edited_at),
    downloadedAt: num(r.downloaded_at),
    libraryEntryId: num(r.library_entry_id),
  };
}

export async function getSkillDraft(useCaseId: string): Promise<SkillDraftRecord | null> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  const rows = (await client.select().from(t).where(eq(t.use_case_id, useCaseId)).limit(1)) as unknown as Row[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function findDraftBySkillName(skillName: string): Promise<SkillDraftRecord | null> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  const rows = (await client.select().from(t).where(eq(t.skill_name, skillName)).limit(1)) as unknown as Row[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function upsertGeneratedDraft(useCaseId: string, draft: ValidatedSkillDraft, stats: SkillCorpusStats, model: string, nowS: number): Promise<SkillDraftRecord> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  const values = {
    use_case_id: useCaseId,
    skill_name: draft.name,
    description: draft.description,
    body_md: draft.body,
    owner_questions_json: JSON.stringify(draft.ownerQuestions.map(q => ({ q, done: false }))),
    citations_json: JSON.stringify(draft.citations),
    corpus_stats_json: JSON.stringify(stats),
    thin: draft.thin ? 1 : 0,
    model,
    generated_at: nowS,
    edited_at: null,
    downloaded_at: null,
    library_entry_id: null,
  };
  await client.insert(t).values(values as never).onConflictDoUpdate({
    target: t.use_case_id,
    set: {
      skill_name: sql`excluded.skill_name`,
      description: sql`excluded.description`,
      body_md: sql`excluded.body_md`,
      owner_questions_json: sql`excluded.owner_questions_json`,
      citations_json: sql`excluded.citations_json`,
      corpus_stats_json: sql`excluded.corpus_stats_json`,
      thin: sql`excluded.thin`,
      model: sql`excluded.model`,
      generated_at: sql`excluded.generated_at`,
      edited_at: sql`NULL`,
      // downloaded_at and library_entry_id are deliberately absent: they persist.
    } as never,
  });
  return (await getSkillDraft(useCaseId))!;
}

export async function patchSkillDraft(
  useCaseId: string,
  patch: { skillName?: string; description?: string; bodyMd?: string; ownerQuestions?: OwnerQuestion[] },
  nowS: number,
): Promise<SkillDraftRecord | null> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  const set: Record<string, unknown> = { edited_at: nowS };
  if (patch.skillName !== undefined) set.skill_name = patch.skillName;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.bodyMd !== undefined) set.body_md = patch.bodyMd;
  if (patch.ownerQuestions !== undefined) set.owner_questions_json = JSON.stringify(patch.ownerQuestions);
  await client.update(t).set(set as never).where(eq(t.use_case_id, useCaseId));
  return getSkillDraft(useCaseId);
}

/**
 * Stamps downloaded_at the first time only, and re-links library_entry_id when
 * it is null (the Board row was deleted, FK SET NULL, then recreated). Neither
 * an existing downloaded_at nor an existing link is ever moved.
 */
export async function markDownloaded(useCaseId: string, libraryEntryId: number, nowS: number): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  await client.update(t)
    .set({
      downloaded_at: sql`COALESCE(${t.downloaded_at}, ${nowS})`,
      library_entry_id: sql`COALESCE(${t.library_entry_id}, ${libraryEntryId})`,
    } as never)
    .where(eq(t.use_case_id, useCaseId));
}

/**
 * Discards an unpublished draft (never called once downloaded_at is set — the
 * caller checks that first, since a downloaded draft already owns a rule entry
 * and a Board row that deleting the row here would orphan).
 */
export async function deleteSkillDraft(useCaseId: string): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  await client.delete(t).where(eq(t.use_case_id, useCaseId));
}

/**
 * Undoes the codification stamp when the Board entry is deleted from the S&C
 * Board: downloaded_at and library_entry_id go back to null
 * so the panel returns to "draft — not yet downloaded". The draft text itself
 * is kept — Discard on the use case page is the way to throw it away.
 */
export async function resetCodified(useCaseId: string): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseSkillDrafts;
  await client.update(t).set({ downloaded_at: null, library_entry_id: null } as never).where(eq(t.use_case_id, useCaseId));
}

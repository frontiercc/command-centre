// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-facing glue for "Turn this into a skill": the shared route gate, the
 * no-LLM view (corpus stats + readiness + stored draft) that both the
 * skill-draft route and the use case detail GET return, the canvas lookup for
 * a mined use case, and the free-name resolution for a generated draft.
 * Lives here, not in a route file, because Next.js rejects non-handler
 * exports from route.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getUseCase, type UseCase } from '@/lib/usecases/queries';
import { gatherSkillCorpus, type SkillCorpus } from '@/lib/usecases/skill-corpus';
import { assessReadiness, thresholdsFromConfig, type Readiness, type SkillCorpusStats } from '@/lib/usecases/skill-readiness';
import { getSkillDraft, findDraftBySkillName, type SkillDraftRecord } from '@/lib/usecases/skill-draft-store';
import { canvasFactsFrom, type CanvasFacts } from '@/lib/usecases/skill-draft';
import { isValidSkillName } from '@/lib/usecases/skill-draft-validate';
import { boardNameConflict } from '@/lib/usecases/skill-publish';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';

export interface SkillDraftView {
  readiness: Readiness;
  stats: SkillCorpusStats;
  contentOn: boolean;
  draft: SkillDraftRecord | null;
}

export type Gate =
  | { ok: true; uc: UseCase; session: { userId: string; email: string } }
  | { ok: false; res: NextResponse };

/** Shared gate, checked in this order: flag 404 → 401 → 403 → use case 404 → confirmed 409. */
/**
 * The model "Turn this into a skill" drafts with: the `skillDraftModel` setting
 * (Admin → Use Cases → Skill drafting; default Sonnet 5). A blank stored value
 * resolves to that default, so this only ever returns undefined (= the Core AI
 * model fallback inside generateSkillDraft) if the config layer itself yields
 * nothing. Design decision: this capability gets its own model, since
 * Haiku failed the no-invented-number / no-verbatim-copy checks on about half
 * of first clicks and nobody wanted Sonnet for every other Core AI use.
 */
export async function resolveSkillDraftModel(): Promise<string | undefined> {
  const cfg = await getAllConfig() as unknown as Record<string, string | undefined>;
  const m = (cfg.skillDraftModel ?? '').trim();
  return m || undefined;
}

export async function gate(request: NextRequest, params: Promise<{ id: string }>): Promise<Gate> {
  if ((await getAllConfig()).useCasesEnabled !== true) return { ok: false, res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  const session = await getAdminSession(request);
  if (!session.authenticated) return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canAccessPulseAdmin(session.role)) return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const { id } = await params;
  const uc = await getUseCase(decodeURIComponent(id));
  if (!uc) return { ok: false, res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  if (uc.status !== 'confirmed') return { ok: false, res: NextResponse.json({ error: 'not_confirmed' }, { status: 409 }) };
  return { ok: true, uc, session: { userId: session.userId ?? '', email: session.email ?? '' } };
}

export async function assessUseCase(uc: UseCase, nowS: number): Promise<{ corpus: SkillCorpus; readiness: Readiness; contentOn: boolean }> {
  const cfg = await getAllConfig() as unknown as Record<string, string | undefined>;
  const corpus = await gatherSkillCorpus(uc.id, nowS);
  const readiness = assessReadiness(corpus.stats, thresholdsFromConfig(cfg));
  return { corpus, readiness, contentOn: cfg.useCasesSuggestUseContent === 'true' };
}

export async function buildSkillDraftView(uc: UseCase, nowS: number): Promise<SkillDraftView> {
  const { corpus, readiness, contentOn } = await assessUseCase(uc, nowS);
  return { readiness, stats: corpus.stats, contentOn, draft: await getSkillDraft(uc.id) };
}

/** A process_mined use case's source canvas: the 'added' suggestion with the same title in one of its departments, or a cross-department one (department NULL). */
export async function findCanvasForUseCase(uc: UseCase): Promise<CanvasFacts | null> {
  if (uc.captureMethod !== 'process_mined' || uc.departments.length === 0) return null;
  const client = await getTypedClient();
  const s = schema.useCaseSuggestions;
  const rows = await client.select({ canvas_json: s.canvas_json }).from(s)
    .where(and(eq(s.title, uc.title), eq(s.status, 'added'), or(inArray(s.department, uc.departments), isNull(s.department)), isNotNull(s.canvas_json)))
    .orderBy(sql`${s.department} IS NULL`).limit(1);
  if (!rows[0]?.canvas_json) return null;
  try { return canvasFactsFrom(JSON.parse(rows[0].canvas_json) as ProcessCanvas); } catch { return null; }
}

/**
 * True when another use case's draft holds the name, or someone else has
 * claimed it on the S&C Board. `hasBoardRow` means this draft already owns a
 * Board row that a name change would rename: then an UNCLAIMED row with the
 * name is a collision too, because skill_library_entries.name is UNIQUE and
 * the rename would violate it (before download, an unclaimed row is simply
 * claimed by the first download).
 */
export async function skillNameTaken(name: string, useCaseId: string, hasBoardRow = false): Promise<boolean> {
  const other = await findDraftBySkillName(name);
  if (other && other.useCaseId !== useCaseId) return true;
  const state = await boardNameConflict(name, useCaseId);
  return state === 'other' || (hasBoardRow && state === 'unclaimed');
}

const MAX_SUFFIX = 99;

/**
 * The model picks the name, so a generated name can collide. Returns the name
 * unchanged when free, else the first free `name-2`, `name-3`, … that is still
 * spec-valid (≤ 64 chars, trimming the base if needed). An 'unclaimed' Board
 * entry is not a collision unless this draft already owns a Board row (see
 * skillNameTaken): the first download claims it. Null when nothing
 * up to MAX_SUFFIX is free.
 */
export async function resolveFreeSkillName(name: string, useCaseId: string, hasBoardRow = false): Promise<string | null> {
  if (!(await skillNameTaken(name, useCaseId, hasBoardRow))) return name;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const suffix = `-${n}`;
    const base = name.slice(0, 64 - suffix.length).replace(/-+$/, '');
    const candidate = `${base}${suffix}`;
    if (!isValidSkillName(candidate)) continue;
    if (!(await skillNameTaken(candidate, useCaseId, hasBoardRow))) return candidate;
  }
  return null;
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logAccess } from '@/lib/audit/log';
import { assessUseCase, buildSkillDraftView, findCanvasForUseCase, gate, resolveFreeSkillName, resolveSkillDraftModel, skillNameTaken } from '@/lib/usecases/skill-draft-service';
import { generateSkillDraft, listKnownSystemNames, type CallModel } from '@/lib/usecases/skill-draft';
import { validateEdit } from '@/lib/usecases/skill-draft-validate';
import { deleteSkillDraft, getSkillDraft, patchSkillDraft, upsertGeneratedDraft, type OwnerQuestion, type SkillDraftRecord } from '@/lib/usecases/skill-draft-store';
import { renameCodifiedSkill, syncBoardDescription } from '@/lib/usecases/skill-publish';

export const dynamic = 'force-dynamic';

/** The draft already owns an S&C Board row, so a name change renames that row. */
function hasBoardRow(d: SkillDraftRecord | null): boolean {
  return !!d && d.downloadedAt !== null && d.libraryEntryId !== null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (!g.ok) return g.res;
  return NextResponse.json(await buildSkillDraftView(g.uc, Math.floor(Date.now() / 1000)));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (!g.ok) return g.res;
  const nowS = Math.floor(Date.now() / 1000);
  const audit = (outcome: 'success' | 'denied' | 'failure', detail: string) =>
    logAccess({ actorId: g.session.userId, actorEmail: g.session.email, resource: 'use-cases/skill-draft', action: 'WRITE', outcome, detail });

  const { corpus, readiness, contentOn } = await assessUseCase(g.uc, nowS);
  if (!contentOn) { await audit('denied', `${g.uc.id}: content_off`); return NextResponse.json({ error: 'content_off' }, { status: 409 }); }
  if (!readiness.ready) { await audit('denied', `${g.uc.id}: not_ready`); return NextResponse.json({ error: 'not_ready', missing: readiness.missing }, { status: 409 }); }
  // Readiness is judged on the full evidence, the model sees only the sample.
  // Should the sample ever come out empty, refuse rather than spend two model
  // calls that must fail.
  if (corpus.excerpts.length === 0) {
    await audit('denied', `${g.uc.id}: not_ready (no readable prompts in the sample)`);
    return NextResponse.json({ error: 'not_ready', missing: [{ key: 'prompts', label: 'readable prompts', have: 0, need: 1 }] }, { status: 409 });
  }

  // Captured before the upsert: a regenerate after download is a rename of what was codified.
  const existing = await getSkillDraft(g.uc.id);
  const replace = request.nextUrl.searchParams.get('replace') === '1';
  if (existing?.editedAt && !replace) { await audit('denied', `${g.uc.id}: edited`); return NextResponse.json({ error: 'edited' }, { status: 409 }); }

  const canvas = await findCanvasForUseCase(g.uc);
  let known: string[] = [];
  try {
    known = await listKnownSystemNames();
  } catch (err) {
    // A lookup hiccup must not block a draft; the validator then treats no system as known.
    console.error('[UseCases] skill-draft known-systems lookup failed:', err instanceof Error ? err.message : err);
  }
  // Test-only injection point: a vitest file may set globalThis.__cccSkillDraftCallModel. Never set in production code.
  const injected = (globalThis as Record<string, unknown>).__cccSkillDraftCallModel as CallModel | undefined;
  const { result, model } = await generateSkillDraft(
    { title: g.uc.title, description: g.uc.description, departments: g.uc.departments }, canvas, corpus, known, injected, await resolveSkillDraftModel());

  if (!result.ok) {
    await audit('failure', `${g.uc.id}: ${result.reasons.join('; ').slice(0, 500)}`);
    // A thrown model call (no key, network, Anthropic error) is a service fault,
    // not a draft that failed our checks: the panel says so.
    if (result.reasons.some(r => r.startsWith('model call failed'))) {
      return NextResponse.json({ error: 'model_unavailable' }, { status: 502 });
    }
    return NextResponse.json({ error: 'generation_failed', reasons: result.reasons }, { status: 502 });
  }

  // The model chose the name: suffix it when another draft or someone else's Board entry holds it.
  const name = await resolveFreeSkillName(result.draft.name, g.uc.id, hasBoardRow(existing));
  if (!name) {
    await audit('denied', `${g.uc.id}: name_taken ${result.draft.name}`);
    return NextResponse.json({ error: 'name_taken' }, { status: 409 });
  }
  const draft = await upsertGeneratedDraft(g.uc.id, { ...result.draft, name }, corpus.stats, model, nowS);

  if (existing && existing.downloadedAt !== null) {
    try {
      if (existing.skillName !== draft.skillName) await renameCodifiedSkill(g.uc, draft, existing.skillName, draft.skillName);
      await syncBoardDescription(draft, nowS);
    } catch (err) {
      // The draft is already stored; a rename/sync failure here is a visible mismatch,
      // not a lost draft — surface it in the console and the audit log rather than 500.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[UseCases] skill-draft rename after regenerate failed for ${g.uc.id}:`, message);
      await audit('failure', `${g.uc.id}: rename after regenerate failed: ${message}`);
    }
  }
  await audit('success', `${g.uc.id}: drafted ${draft.skillName} from ${corpus.stats.prompts} prompts`);
  return NextResponse.json({ draft });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (!g.ok) return g.res;
  const audit = (outcome: 'success' | 'denied' | 'failure', detail: string) =>
    logAccess({ actorId: g.session.userId, actorEmail: g.session.email, resource: 'use-cases/skill-draft', action: 'WRITE', outcome, detail });
  const existing = await getSkillDraft(g.uc.id);
  if (!existing) { await audit('denied', `${g.uc.id}: no draft`); return NextResponse.json({ error: 'Not found' }, { status: 404 }); }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const patch: { skillName?: string; description?: string; bodyMd?: string; ownerQuestions?: OwnerQuestion[] } = {};
  if (typeof body.skillName === 'string') patch.skillName = body.skillName.trim();
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.bodyMd === 'string') patch.bodyMd = body.bodyMd;
  if (Array.isArray(body.ownerQuestions)) {
    patch.ownerQuestions = body.ownerQuestions
      .filter((q): q is { q: string; done?: unknown } => !!q && typeof q === 'object' && typeof (q as { q?: unknown }).q === 'string')
      .map(q => ({ q: q.q.slice(0, 500), done: q.done === true }));
  }
  const reasons = validateEdit(patch);
  if (reasons.length) {
    await audit('denied', `${g.uc.id}: invalid ${reasons.join('; ').slice(0, 400)}`);
    return NextResponse.json({ error: 'invalid', reasons }, { status: 400 });
  }

  const newName = patch.skillName !== undefined && patch.skillName !== existing.skillName ? patch.skillName : null;
  // Collision check BEFORE any write.
  if (newName !== null && await skillNameTaken(newName, g.uc.id, hasBoardRow(existing))) {
    await audit('denied', `${g.uc.id}: name_taken ${newName}`);
    return NextResponse.json({ error: 'name_taken' }, { status: 409 });
  }

  const nowS = Math.floor(Date.now() / 1000);
  const updated = await patchSkillDraft(g.uc.id, patch, nowS);
  if (updated && existing.downloadedAt !== null) {
    try {
      if (newName !== null) await renameCodifiedSkill(g.uc, updated, existing.skillName, newName);
      if (patch.description !== undefined && patch.description !== existing.description) await syncBoardDescription(updated, nowS);
    } catch (err) {
      // Same stance as POST: the edit is stored; a rename/sync failure is a
      // visible mismatch, surfaced in the console and the audit log, not a 500.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[UseCases] skill-draft rename after edit failed for ${g.uc.id}:`, message);
      await audit('failure', `${g.uc.id}: rename after edit failed: ${message}`);
    }
  }
  await audit('success', `${g.uc.id}: edited ${Object.keys(patch).join(',')}`);
  return NextResponse.json({ draft: updated });
}

/**
 * Discards an unpublished draft — the panel's "Cancel"/"Discard draft" affordances
 * (in case "Turn this into a skill" is clicked by mistake). Once
 * downloaded the draft already owns a rule entry and a Board row, so discarding it
 * here would orphan them; Regenerate is the path after download instead.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (!g.ok) return g.res;
  const audit = (outcome: 'success' | 'denied' | 'failure', detail: string) =>
    logAccess({ actorId: g.session.userId, actorEmail: g.session.email, resource: 'use-cases/skill-draft', action: 'DELETE', outcome, detail });
  const existing = await getSkillDraft(g.uc.id);
  if (!existing) { await audit('denied', `${g.uc.id}: no draft`); return NextResponse.json({ error: 'Not found' }, { status: 404 }); }
  if (existing.downloadedAt !== null) { await audit('denied', `${g.uc.id}: downloaded`); return NextResponse.json({ error: 'downloaded' }, { status: 409 }); }
  await deleteSkillDraft(g.uc.id);
  await audit('success', `${g.uc.id}: discarded ${existing.skillName}`);
  return NextResponse.json({ ok: true });
}

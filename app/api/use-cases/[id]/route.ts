// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getUseCase, updateUseCase, deleteUseCase } from '@/lib/usecases/queries';
import { getMeasuredCompletedWeeks, getCurrentWeek } from '@/lib/usecases/weeks';
import { findSpreadCandidates } from '@/lib/usecases/spread';
import { buildUseCaseImpact } from '@/lib/usecases/impact';
import { activateUseCase, type ActivateEvidence } from '@/lib/usecases/match';
import type { UseCase } from '@/lib/usecases/queries';
import { bootstrapUseCase } from '@/lib/usecases/tracker';
import { buildSkillDraftView } from '@/lib/usecases/skill-draft-service';

export const dynamic = 'force-dynamic';

const VALID_ORIGINS = new Set(['planned', 'emergent', 'ideated']);
const VALID_STATUSES = new Set(['candidate', 'confirmed', 'archived']);

// Fields the session judge reads: what the work is (title,
// description), its clues, and who and where it applies. Changing one asks for
// a judging run, which judges the department's last 13 weeks again against the
// changed use case, instead of waiting for the hourly run.
const RULE_FIELDS = ['keywords', 'skills', 'connectors', 'taskTypes', 'surfaces', 'departments'] as const;
const TEXT_FIELDS = ['title', 'description', 'status'] as const;

function sameStringArray(a: unknown, b: unknown): boolean {
  const arrA = Array.isArray(a) ? [...a].sort() : [];
  const arrB = Array.isArray(b) ? [...b].sort() : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((v, i) => v === arrB[i]);
}

/** The detail page's live activity box: the use case's judged sessions in the last 30 days (lib/usecases/match.ts). */
async function computeLiveEvidence(uc: UseCase, nowS: number): Promise<ActivateEvidence | null> {
  return activateUseCase(uc, nowS);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const uc = await getUseCase(decodeURIComponent(id));
  if (!uc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const nowS = Math.floor(Date.now() / 1000);
  const currentWeek = await getCurrentWeek(uc.id, nowS);
  const weeks = [
    ...(await getMeasuredCompletedWeeks(uc.id, 8, nowS)),
    ...(currentWeek ? [currentWeek] : []),
  ];

  const [spread, impact, liveEvidence] = await Promise.all([
    findSpreadCandidates(uc, nowS),
    buildUseCaseImpact(uc.id, nowS),
    computeLiveEvidence(uc, nowS),
  ]);
  const impactSummary = { text: uc.impactSummary ?? null, generatedAt: uc.impactSummaryAt ?? null };

  // Confirmed use cases only, and isolated: a failure here hides one field, not the page.
  const skillDraft = uc.status === 'confirmed'
    ? await buildSkillDraftView(uc, nowS).catch(err => { console.error('[UseCases] skillDraft view failed:', err instanceof Error ? err.message : err); return null; })
    : null;

  return NextResponse.json({ ...uc, weeks, spread, impact, impactSummary, liveEvidence, skillDraft });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const uc = await getUseCase(decodeURIComponent(id));
  if (!uc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // lifecycle is tracker-owned (derived from telemetry) — never client-settable.
  // Not in ALLOWED_FIELDS below, but stripped explicitly as a defence-in-depth
  // guard against the allowlist ever being widened carelessly.
  delete (body as Record<string, unknown>).lifecycle;
  delete (body as Record<string, unknown>).lifecycleChangedAt;

  const ALLOWED_FIELDS = [
    'title', 'description', 'ownerUserId', 'departments', 'surfaces',
    'keywords', 'skills', 'connectors', 'taskTypes', 'origin', 'status',
    'captureMethod', 'sourceExcerpt', 'strategic',
    'painPoint', 'valueHypothesis', 'baselineNote', 'kpiNote',
  ] as const;

  // Department Process Transformation canvas fields — human-entered display
  // text, never matched/derived, so (unlike RULE_FIELDS) editing them never
  // triggers the matching-rule re-check. Same 500-char slice as the other
  // free-text fields (the captureMethod/sourceExcerpt precedent); null
  // clears a previously-set value.
  const CANVAS_FIELDS = ['painPoint', 'valueHypothesis', 'baselineNote', 'kpiNote'] as const;
  for (const field of CANVAS_FIELDS) {
    if (field in body) {
      const value = (body as Record<string, unknown>)[field];
      (body as Record<string, unknown>)[field] = typeof value === 'string' ? value.slice(0, 500) : null;
    }
  }

  if ('title' in body && (body.title === null || typeof body.title !== 'string' || body.title.trim() === '')) {
    return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
  }

  if ('origin' in body && !VALID_ORIGINS.has(body.origin as string)) {
    return NextResponse.json({ error: 'invalid origin' }, { status: 400 });
  }

  if ('status' in body && !VALID_STATUSES.has(body.status as string)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    if (field in body) patch[field] = body[field];
  }

  if ('strategic' in patch) {
    patch.strategic = patch.strategic ? 1 : 0;
  }

  const ruleChanged = RULE_FIELDS.some(field => field in patch && !sameStringArray(uc[field], patch[field]))
    || TEXT_FIELDS.some(field => field in patch && patch[field] !== uc[field]);

  const updated = await updateUseCase(decodeURIComponent(id), patch);

  if (ruleChanged) {
    // Fire-and-forget: refreshes the stage and asks for a judging run; the
    // PATCH response does not wait on it.
    bootstrapUseCase(decodeURIComponent(id)).catch(err => {
      console.error(`[UseCases] rule-change bootstrap failed for ${decodeURIComponent(id)}:`, err instanceof Error ? err.message : err);
    });
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const uc = await getUseCase(decodeURIComponent(id));
  if (!uc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await deleteUseCase(decodeURIComponent(id));
  return NextResponse.json({ ok: true });
}

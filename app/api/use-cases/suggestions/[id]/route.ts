// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getSuggestionById, setSuggestionStatus } from '@/lib/usecases/suggestion-store';
import { createUseCase } from '@/lib/usecases/queries';
import { bootstrapUseCase } from '@/lib/usecases/tracker';

export const dynamic = 'force-dynamic';

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
  const body = await request.json().catch(() => null);
  const s = await getSuggestionById(decodeURIComponent(id));
  if (!s) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (body?.action === 'dismiss') {
    await setSuggestionStatus(s.id, 'dismissed');
    return NextResponse.json({ ok: true });
  }

  if (body?.action === 'add') {
    const slots = {
      ownerUserId: typeof body?.ownerUserId === 'string' ? body.ownerUserId.slice(0, 200) : undefined,
      baselineNote: typeof body?.baselineNote === 'string' ? body.baselineNote.slice(0, 500) : undefined,
      valueNote: typeof body?.valueNote === 'string' ? body.valueNote.slice(0, 500) : undefined,
      kpiNote: typeof body?.kpiNote === 'string' ? body.kpiNote.slice(0, 500) : undefined,
    };
    const uc = await createUseCase({
      title: s.title,
      description: s.description ?? undefined,
      departments: s.matchingRule.departments,
      keywords: s.matchingRule.keywords ?? [],
      skills: s.matchingRule.skills,
      connectors: s.matchingRule.connectors,
      taskTypes: s.matchingRule.taskTypes,
      origin: 'emergent',
      // Dept-scoped process-mined suggestions go straight to confirmed: a
      // human already reviewed the drafted
      // canvas before clicking Confirm, unlike an org-wide tray "Add" which
      // stays a candidate pending review. See app/use-cases/page.tsx.
      // Cross-department suggestions (department NULL) are added from the
      // list with "Add" and land as candidates. They keep process_mined so
      // the use case page
      // and skill drafting find their canvas.
      status: s.department ? 'confirmed' : 'candidate',
      captureMethod: s.canvas ? 'process_mined' : 'suggested',
      createdBy: session.userId,
      ownerUserId: slots.ownerUserId,
      painPoint: s.canvas?.story ?? undefined,
      valueHypothesis: slots.valueNote ?? s.canvas?.valueHypothesis ?? undefined,
      baselineNote: slots.baselineNote,
      kpiNote: slots.kpiNote,
    });
    await setSuggestionStatus(s.id, 'added');

    if (s.canvas) {
      // Fire-and-forget: a mined process asks the session judge to read
      // its departments' last 13 weeks at once (same as a description edit in
      // app/api/use-cases/[id]/route.ts), so its page fills within minutes.
      bootstrapUseCase(uc.id).catch(err => {
        console.error(`[UseCases] confirm bootstrap failed for ${uc.id}:`, err instanceof Error ? err.message : err);
      });
    }

    return NextResponse.json({ ok: true, useCaseId: uc.id });
  }

  return NextResponse.json({ error: 'invalid action' }, { status: 400 });
}

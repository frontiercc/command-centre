// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logAccess } from '@/lib/audit/log';
import { gate } from '@/lib/usecases/skill-draft-service';
import { getSkillDraft } from '@/lib/usecases/skill-draft-store';
import { applyFirstDownloadEffects, buildSkillZip, BoardNameTakenError } from '@/lib/usecases/skill-publish';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (!g.ok) return g.res;
  const audit = (outcome: 'success' | 'denied' | 'failure', detail: string) =>
    logAccess({ actorId: g.session.userId, actorEmail: g.session.email, resource: 'use-cases/skill-draft', action: 'EXPORT', outcome, detail });
  const draft = await getSkillDraft(g.uc.id);
  if (!draft) { await audit('denied', `${g.uc.id}: no draft`); return NextResponse.json({ error: 'Not found' }, { status: 404 }); }

  const nowS = Math.floor(Date.now() / 1000);

  try {
    await applyFirstDownloadEffects(g.uc, draft, g.session, nowS);
  } catch (err) {
    if (err instanceof BoardNameTakenError) {
      await audit('denied', `${g.uc.id}: name_taken ${draft.skillName}`);
      return NextResponse.json({ error: 'name_taken' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[UseCases] skill-draft first-download effects failed for ${g.uc.id}:`, message);
    await audit('failure', `${g.uc.id}: ${message.slice(0, 500)}`);
    return NextResponse.json({ error: 'download_failed' }, { status: 500 });
  }
  const fresh = (await getSkillDraft(g.uc.id)) ?? draft;
  const buffer = await buildSkillZip(fresh, g.uc.departments[0] ?? null, g.uc.title);

  await audit('success', `${g.uc.id}: ${fresh.skillName}.zip`);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=${fresh.skillName}.zip`,
      'Content-Length': String(buffer.length),
    },
  });
}

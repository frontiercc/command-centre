// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — generate a draft post for the last completed week.
 * Flag-404 BEFORE auth (finance-route pattern); admin-only; logAccess-audited.
 * D1 (spec): when there is no usable stored content the route REFUSES with a
 * plain-English reason — it never degrades to a stats-only post.
 * Nothing is persisted; every call regenerates.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { gatherHighlights } from '@/lib/highlights/gather';
import { composeHighlights } from '@/lib/highlights/compose';
import { renderHighlightsPost } from '@/lib/highlights/render';
import { logAccess } from '@/lib/audit/log';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if ((await getConfigValue('highlightsEnabled')) !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });

  try {
    const includeNames = (await getConfigValue('highlightsIncludeNames')) === 'true';
    const input = await gatherHighlights({ includeNames });

    if (input.workItems.length === 0) {
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: 'highlights', action: 'READ', outcome: 'denied', detail: 'refused: no stored content for the completed week' });
      return NextResponse.json({
        error: 'no_content',
        message: 'No highlights can be written for last week: there is no stored request content for top-tier work in the window. This happens when the week had no tier-3 classified work, or when content-strip retention has removed the stored text. The post depends on real request text, so a stats-only version is deliberately not produced.',
      }, { status: 422 });
    }

    const composed = await composeHighlights(input);
    if (!composed) {
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: 'highlights', action: 'READ', outcome: 'failure', detail: 'compose failed after outbound model call' });
      return NextResponse.json({ error: 'compose_failed', message: 'The model call failed or produced nothing that could be traced back to real work items. Try again, or check the AI API key on /admin/security.' }, { status: 502 });
    }

    const post = renderHighlightsPost(input, composed);
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: 'highlights', action: 'READ', outcome: 'success', detail: `preview generated (${composed.deliverables.length} deliverables)` });
    return NextResponse.json({ post, weekStart: input.weekStart, weekEnd: input.weekEnd, deliverableCount: composed.deliverables.length });
  } catch (err) {
    return errorResponse('Highlights', err, { message: 'Could not generate the draft. Details are in the server log.' });
  }
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps → Spend Review click-through: the prompts of one of the person's sessions, in
// order. Prompt text follows the Audit Log rule exactly (gateContentRead:
// admin and manager only, department-scoped, every read access-logged). Only
// the person's own prompts are returned — never assistant text.
import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { gateContentRead, scopedDepartment, filterRowsToDepartment } from '@/lib/auth/content-access';
import { errorResponse } from '@/lib/api/errors';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const MAX_PROMPTS = 200;
const MAX_PROMPT_CHARS = 4000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string; sessionId: string }> },
) {
  // Part of FinOps: hidden with it (finance pattern, 404 before auth).
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const gate = await gateContentRead(request, 'finance/spend-review/session');
  if ('response' in gate) return gate.response;
  const p = await params;
  const userId = decodeURIComponent(p.userId);
  const sessionId = decodeURIComponent(p.sessionId);

  try {
    const client = await getTypedClient();
    const cm = schema.coworkMessages;
    const rows = await client
      .select({ id: cm.id, user_id: cm.user_id, text: cm.content_full, preview: cm.content_preview, occurred_at: cm.occurred_at, flagged: cm.flagged })
      .from(cm)
      .where(and(
        eq(cm.session_id, sessionId),
        eq(cm.user_id, userId),
        inArray(cm.message_type, ['cowork_user_message', 'code_user_message']),
      ))
      .orderBy(asc(cm.occurred_at))
      .limit(MAX_PROMPTS);
    const visible = await filterRowsToDepartment(rows, scopedDepartment(gate.session));
    return NextResponse.json({
      sessionId,
      prompts: visible.map(r => ({
        id: r.id,
        occurredAt: Number(r.occurred_at),
        text: (r.text ?? r.preview ?? '').slice(0, MAX_PROMPT_CHARS),
        flagged: Number(r.flagged) === 1,
      })),
    });
  } catch (err) {
    return errorResponse('api/finance/spend-review/session', err, { message: 'Could not load the session.' });
  }
}

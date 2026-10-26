// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the money went for one Audit Log conversation, and for the prompt open
 * in it. Same gate as the conversation view (/api/cowork/messages): admins and
 * managers, a department-scoped manager only for their own department's people.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { gateContentRead, scopedDepartment, filterRowsToDepartment } from '@/lib/auth/content-access';
import { buildSessionSpend } from '@/lib/finance/session-spend';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await gateContentRead(request, 'audit/session-spend');
  if ('response' in gate) return gate.response;

  const params = request.nextUrl.searchParams;
  const sessionId = params.get('sessionId');
  if (!sessionId || sessionId.length > 200) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  const promptId = params.get('promptId');
  if (promptId && promptId.length > 200) return NextResponse.json({ error: 'promptId is too long' }, { status: 400 });

  try {
    const spend = await buildSessionSpend(sessionId, promptId || null);
    const dept = scopedDepartment(gate.session);
    if (dept !== null) {
      const visible = await filterRowsToDepartment([{ user_id: spend.userId }], dept);
      if (visible.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ surface: spend.surface, conversation: spend.conversation, prompt: spend.prompt });
  } catch (err) {
    return errorResponse('Audit session spend', err, { message: 'Could not load this conversation\'s spend.' });
  }
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getCoworkMessages, getRecentCoworkSessions } from '@/lib/db/queries';
import { gateContentRead, scopedDepartment, filterRowsToDepartment } from '@/lib/auth/content-access';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const sessionId = params.get('sessionId');

  // If no sessionId, return recent sessions for browsing. Org-wide and
  // unscoped, and no page uses it — admin only.
  if (!sessionId) {
    const gate = await gateContentRead(request, 'cowork/messages', { adminOnly: true });
    if ('response' in gate) return gate.response;
    const sessions = await getRecentCoworkSessions(50);
    return NextResponse.json({ sessions });
  }

  // One session's messages (the Audit Log conversation view): same gate as
  // /api/events, and a department-scoped caller sees only their department.
  const gate = await gateContentRead(request, 'cowork/messages');
  if ('response' in gate) return gate.response;

  const limit = parseInt(params.get('limit') || '200');
  const messages = await filterRowsToDepartment(
    await getCoworkMessages(sessionId, limit),
    scopedDepartment(gate.session),
  );

  return NextResponse.json({ messages, sessionId });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getChatMessages, getChatMessageCount, getChatFlaggedCount } from '@/lib/db/queries';
import { gateContentRead } from '@/lib/auth/content-access';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Org-wide Chat prompts with no department scoping, and no page uses it —
  // admin only.
  const gate = await gateContentRead(request, 'chat/messages', { adminOnly: true });
  if ('response' in gate) return gate.response;
  const params = request.nextUrl.searchParams;

  const userId = params.get('userId') || undefined;
  const conversationId = params.get('conversationId') || undefined;
  const flaggedOnly = params.get('flagged') === 'true';
  const dateFrom = params.get('dateFrom') ? parseInt(params.get('dateFrom')!) : undefined;
  const dateTo = params.get('dateTo') ? parseInt(params.get('dateTo')!) : undefined;
  const limit = parseInt(params.get('limit') || '100');
  const offset = parseInt(params.get('offset') || '0');

  try {
    const messages = await getChatMessages({ userId, conversationId, flaggedOnly, dateFrom, dateTo, limit, offset });
    const total = await getChatMessageCount();
    const flaggedCount = await getChatFlaggedCount();

    return NextResponse.json({
      messages,
      total,
      flaggedCount,
    });
  } catch (err) {
    return errorResponse('api/chat/messages', err);
  }
}

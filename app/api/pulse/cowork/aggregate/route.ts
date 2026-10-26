// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { aggregateCoworkSessionStats } from '@/lib/pulse/cowork/session-aggregator';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Runs the aggregator job — admin only.
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { sessionId?: string };
  const result = await aggregateCoworkSessionStats(body.sessionId);
  return NextResponse.json(result);
}

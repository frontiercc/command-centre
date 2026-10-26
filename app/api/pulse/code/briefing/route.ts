// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { aiFailureOptions } from '@/lib/anthropic/grounded-json';
import { getAdminSession, canAccessCodePulse } from '@/lib/auth/admin-auth';
import { generateCodeBriefing, getLatestCodeBriefing } from '@/lib/pulse/code/briefing';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessCodePulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ briefing: await getLatestCodeBriefing() });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const briefing = await generateCodeBriefing();
    return NextResponse.json({ briefing });
  } catch (err) {
    return errorResponse('Code Briefing', err, aiFailureOptions(err));
  }
}

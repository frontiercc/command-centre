// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAdminSession, canAccessCoworkPulse } from '@/lib/auth/admin-auth';
import { getDiscoverCache, runSkillsDiscover } from '@/lib/pulse/skills-discover';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Same roles as the Work Pulse Skills page that calls it.
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const cache = await getDiscoverCache();
  return NextResponse.json(cache);
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Same roles as the Work Pulse Skills page that calls it.
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const items = await runSkillsDiscover();
    return NextResponse.json({ items, cached_at: new Date().toISOString(), is_stale: false });
  } catch (err) {
    return errorResponse('Skills Discover', err, { message: 'The AI request failed. Details are in the server log.' });
  }
}

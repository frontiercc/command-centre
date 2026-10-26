// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { listUseCases } from '@/lib/usecases/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
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

  const active = (await listUseCases()).filter(u => u.status !== 'archived');
  const by = (l: string) => active.filter(u => u.lifecycle === l).length;
  return NextResponse.json({
    declared: active.length,
    adopted: by('adopted'),
    piloting: by('piloting'),
    atRisk: by('at_risk'),
    notSeen: by('not_seen'),
  });
}

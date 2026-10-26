// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { buildGovernanceRollup } from '@/lib/usecases/governance';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = await getAllConfig();
  if (config.useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Deliberately looser than sibling /api/use-cases/* routes (canAccessPulseAdmin,
  // admin|manager): this read-only rollup opens to viewer-role CIOs as well.
  if (!canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const nowS = Math.floor(Date.now() / 1000);
  const cal = {
    minutesPerSession: parseInt(config.useCasesMinutesSavedPerSession || '30', 10) || 30,
    loadedCompAnnual: parseInt(config.useCasesLoadedCompAnnual || '90000', 10) || 90000,
  };
  return NextResponse.json(await buildGovernanceRollup(nowS, cal));
}

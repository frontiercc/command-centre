// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig, getConfigValue } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { runProcessMiningJob } from '@/lib/usecases/process-mining';

export const dynamic = 'force-dynamic';

const THROTTLE_SECONDS = 120;

/**
 * Runs department process mining now. This is the only source of
 * suggestions. `generated` is kept as an alias of
 * `processGenerated` for older callers; `failed` is true when mining reported
 * a failure (a cut-off or unreadable reply), so the page can say so.
 */
export async function POST(request: NextRequest) {
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

  const now = Math.floor(Date.now() / 1000);
  const last = await getConfigValue('processMiningLastRun');
  const lastRun = last ? parseInt(last, 10) : NaN;
  if (!Number.isNaN(lastRun) && now - lastRun < THROTTLE_SECONDS) {
    return NextResponse.json({ generated: 0, processGenerated: 0, throttled: true });
  }

  let processGenerated = 0;
  let failed = false;
  try {
    processGenerated = (await runProcessMiningJob({ force: true })).generated;
  } catch {
    failed = true;
  }
  return NextResponse.json({ generated: processGenerated, processGenerated, throttled: false, failed });
}

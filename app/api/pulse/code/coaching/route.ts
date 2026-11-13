// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/pulse/code/coaching?department=: one team's coaching plan
// (lib/pulse/code/team-coaching.ts) from the figures in coaching-figures.ts. Admins choose any
// team; a manager gets their own department only. It names people (the ones to learn from), so
// admin and manager only, and every read is access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { parseVendor } from '@/lib/dashboard/vendor';
import { getCoachingFigures } from '@/lib/pulse/code/coaching-figures';
import { buildCoachingPlan, CHECK_AFTER_DAYS } from '@/lib/pulse/code/team-coaching';
import { listDoneActions } from '@/lib/pulse/coaching-store';
import { coachingScope } from '@/lib/pulse/coaching-scope';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  const log = (outcome: 'success' | 'denied', detail?: string) =>
    logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/coaching', action: 'READ', outcome, detail });
  if (!canAccessPulseAdmin(session.role)) {
    await log('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const vendor = parseVendor(request.nextUrl.searchParams.get('vendor'));
    const figures = await getCoachingFigures(vendor);
    const all = figures.teams.map(t => t.department).sort((a, b) => a.localeCompare(b));
    const scope = coachingScope(session, all, request.nextUrl.searchParams.get('department'));
    if ('error' in scope) {
      await log('denied', scope.error);
      return NextResponse.json({ error: scope.error }, { status: 403 });
    }
    await log('success', scope.department ? `department=${scope.department}` : undefined);
    const plan = scope.department
      ? buildCoachingPlan(scope.department, figures, await listDoneActions('code', scope.department), Math.floor(Date.now() / 1000))
      : null;
    return NextResponse.json({ teams: scope.teams, department: scope.department, plan, checkAfterDays: CHECK_AFTER_DAYS });
  } catch (err) {
    return errorResponse('pulse/code/coaching', err);
  }
}

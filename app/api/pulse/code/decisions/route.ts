// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/pulse/code/decisions: what a leader acts on this month (lib/pulse/code/decisions.ts).
// It names teams rather than people, but it is the same figures as Team coaching, so it keeps
// the same gate: admin and manager only, every read access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { parseVendor } from '@/lib/dashboard/vendor';
import { getDecisions } from '@/lib/pulse/code/decisions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  if (!canAccessPulseAdmin(session.role)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/decisions', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/decisions', action: 'READ', outcome: 'success' });
  try {
    return NextResponse.json(await getDecisions(parseVendor(request.nextUrl.searchParams.get('vendor'))));
  } catch (err) {
    return errorResponse('pulse/code/decisions', err);
  }
}

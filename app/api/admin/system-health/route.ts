// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// System health panel (admin only).
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getSystemHealth } from '@/lib/health/system-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = { actorId: session.userId ?? '', actorEmail: session.email ?? '', actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/system-health' };
  if (session.role !== 'admin') {
    await logAccess({ ...actor, action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }
  try {
    const health = await getSystemHealth();
    return NextResponse.json(health);
  } catch (err) {
    await logAccess({ ...actor, action: 'READ', outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Could not load system health' }, { status: 500 });
  }
}

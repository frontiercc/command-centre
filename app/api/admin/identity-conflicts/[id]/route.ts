// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTel identity conflicts: Merge / Keep separate / Undo (admin only).
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { ConflictStateError, decideIdentityConflict, type ConflictAction } from '@/lib/otel/identity-conflicts';

export const dynamic = 'force-dynamic';

const ACTIONS: ConflictAction[] = ['merge', 'separate', 'undo'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = { actorId: session.userId ?? '', actorEmail: session.email ?? '', actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/identity-conflicts' };
  if (session.role !== 'admin') {
    await logAccess({ ...actor, action: 'WRITE', outcome: 'denied', detail: id });
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let action: unknown;
  try { action = (await request.json())?.action; } catch { action = undefined; }
  if (typeof action !== 'string' || !ACTIONS.includes(action as ConflictAction) || !id || id.length > 100) {
    return NextResponse.json({ error: 'Body must be { action: "merge" | "separate" | "undo" }' }, { status: 400 });
  }

  try {
    const status = await decideIdentityConflict(id, action as ConflictAction, session.email ?? '');
    await logAccess({ ...actor, action: 'WRITE', outcome: 'success', detail: `${id}: ${action}` });
    return NextResponse.json({ status });
  } catch (err) {
    if (err instanceof ConflictStateError) {
      const notFound = err.message === 'not_found';
      await logAccess({ ...actor, action: 'WRITE', outcome: 'denied', detail: `${id}: ${action}: ${err.message}` });
      return NextResponse.json({ error: notFound ? 'Conflict not found' : err.message }, { status: notFound ? 404 : 409 });
    }
    await logAccess({ ...actor, action: 'WRITE', outcome: 'error', detail: `${id}: ${action}` });
    return NextResponse.json({ error: 'Could not apply the decision' }, { status: 500 });
  }
}

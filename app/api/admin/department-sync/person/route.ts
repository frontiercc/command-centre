// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// One person's department source, last sync and department changes, for
// their admin page (app/admin/users/[id]). Admin only, access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, inArray, or } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getTypedClient } from '@/lib/db/client';
import * as schema from '@/lib/db/schema.pg';
import { isDepartmentSyncActive } from '@/lib/directory/department-sync';

export const dynamic = 'force-dynamic';

const HISTORY_LIMIT = 20;

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = {
    actorId: session.userId ?? '', actorEmail: session.email ?? '',
    actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/department-sync/person',
    action: 'READ' as const, outcome: 'success' as const,
  };
  if (session.role !== 'admin') {
    await logAccess({ ...actor, outcome: 'denied' });
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }
  const userId = request.nextUrl.searchParams.get('userId') ?? '';
  if (!userId || userId.length > 200) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

  try {
    const db = await getTypedClient();
    const rows = await db.select({
      email: schema.users.email, source: schema.users.department_source, syncedAt: schema.users.department_synced_at,
    }).from(schema.users).where(eq(schema.users.id, userId));
    if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const person = rows[0];
    const admins = await db.select({
      id: schema.adminUsers.id, source: schema.adminUsers.department_source, syncedAt: schema.adminUsers.department_synced_at,
    }).from(schema.adminUsers)
      .where(person.email ? or(eq(schema.adminUsers.linked_cowork_user_id, userId), eq(schema.adminUsers.email, person.email)) : eq(schema.adminUsers.linked_cowork_user_id, userId));

    const sources = [person.source, ...admins.map(a => a.source)];
    const source = sources.includes('manual') ? 'manual' : sources.includes('directory') ? 'directory' : 'other';
    const synced = [person.syncedAt, ...admins.map(a => a.syncedAt)].map(v => Number(v) || 0);
    const syncedAt = Math.max(0, ...synced) || null;

    const adminIds = admins.map(a => a.id);
    const h = schema.departmentHistory;
    const history = await db.select({
      from: h.from_department, to: h.to_department, source: h.source, changedAt: h.changed_at,
    }).from(h)
      .where(adminIds.length > 0 ? or(eq(h.user_id, userId), inArray(h.admin_user_id, adminIds)) : eq(h.user_id, userId))
      .orderBy(desc(h.changed_at))
      .limit(HISTORY_LIMIT);

    await logAccess(actor);
    return NextResponse.json({
      syncActive: await isDepartmentSyncActive(),
      source,
      syncedAt,
      history: history.map(r => ({ ...r, changedAt: Number(r.changedAt) })),
    });
  } catch (err) {
    await logAccess({ ...actor, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Could not load department details' }, { status: 500 });
  }
}

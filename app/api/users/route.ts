// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. The PUT handler runs its own inline UPDATE;
// every function imported from lib/db/queries.ts is async.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  getUsers,
  getDeactivatedUsers,
  getUserById,
  getUserAdoptionHealth,
  getUserPrimarySurface,
  getUserMessageCount7d,
  getUserAlerts,
  getSnapshotsForUser,
  deleteUserData,
  getAllUserAdoptionHealth,
  getAllUserPrimarySurfaces,
  getAllUserMessageCounts7d,
  getAllUserOpenAlertCounts,
  getCoworkUserProjects,
  getCoworkUserSessions,
  deactivateUser,
  reactivateUser,
} from '@/lib/db/queries';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { requireAdmin, getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = request.nextUrl.searchParams;

  // Non-admins never get per-user detail, the deactivated list, or the
  // activity/alert columns. Managers and viewers get a slim directory
  // (id, name, email, department) for the owner picker and the Audit Log /
  // Reports filters; every other role gets department names only, which is
  // all the S&C Board detail page reads.
  if (session.role !== 'admin') {
    if (params.get('deactivated') === 'true' || params.get('id')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const includeAll = params.get('all') === 'true';
    const rows = await getUsers(includeAll ? 100000 : undefined, includeAll);
    if (canAccessCorePlatform(session.role)) {
      return NextResponse.json(rows.map(u => ({
        id: u.id, display_name: u.display_name, email: u.email, department: u.department ?? null,
      })));
    }
    const departments = [...new Set(rows.map(u => u.department).filter((d): d is string => Boolean(d)))].sort();
    return NextResponse.json(departments.map(department => ({ department })));
  }

  // Return deactivated users list
  if (params.get('deactivated') === 'true') {
    const deactivated = await getDeactivatedUsers();
    return NextResponse.json(deactivated);
  }

  const id = params.get('id');
  if (id) {
    const user = await getUserById(id);
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

    const [
      coworkProjects, coworkRecentSessions, userAlerts,
      adoptionHealth, primarySurface, messages7d, snapshots30d,
    ] = await Promise.all([
      getCoworkUserProjects(id, thirtyDaysAgo),
      getCoworkUserSessions(id, thirtyDaysAgo),
      getUserAlerts(id),
      getUserAdoptionHealth(id),
      getUserPrimarySurface(id),
      getUserMessageCount7d(id),
      getSnapshotsForUser(id, 30),
    ]);

    const detail = {
      ...user,
      adoption_health: adoptionHealth,
      primary_surface: primarySurface,
      messages_7d: messages7d,
      alerts: userAlerts,
      snapshots_30d: snapshots30d,
      coworkActivity: {
        projects: coworkProjects,
        recentSessions: coworkRecentSessions,
      },
    };

    return NextResponse.json(detail);
  }

  // `all=true` — every user (incl. deactivated), no 500 cap. Used by filter
  // dropdowns (e.g. the Audit Log) that must offer every user regardless of
  // recency/deactivation, as opposed to the default recent-active-500 list
  // other callers (admin/users, reports, library, etc.) rely on.
  const includeAll = params.get('all') === 'true';

  const [users0, alertMap, adoptionMap, surfaceMap, messageMap] = await Promise.all([
    getUsers(includeAll ? 100000 : undefined, includeAll),
    getAllUserOpenAlertCounts(),
    getAllUserAdoptionHealth(),
    getAllUserPrimarySurfaces(),
    getAllUserMessageCounts7d(),
  ]);

  const users = users0.map(user => ({
    ...user,
    adoption_health: adoptionMap.get(user.id) ?? 'inactive',
    primary_surface: surfaceMap.get(user.id) ?? 'None',
    messages_7d: messageMap.get(user.id) ?? 0,
    open_alerts: alertMap.get(user.id) ?? 0,
  }));

  return NextResponse.json(users);
}

export async function PUT(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const body = await request.json();
  const { id, display_name, department } = body;

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const client = await getTypedClient();
  await client
    .update(schema.users)
    .set({ display_name: display_name ?? null, department: department ?? null })
    .where(eq(schema.users.id, id));

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const body = await request.json();
  const { id, action } = body;

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (action === 'deactivate') {
    await deactivateUser(id, 'manual_admin');
    return NextResponse.json({ ok: true });
  }
  if (action === 'reactivate') {
    await reactivateUser(id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'action must be deactivate or reactivate' }, { status: 400 });
}

export async function DELETE(request: NextRequest) {
  const session = await getAdminSession(request);
  const actor = { actorId: session.userId ?? 'unknown', actorEmail: session.email ?? 'unknown', actorIp: request.headers.get('x-forwarded-for') || undefined };
  if (!session.authenticated || session.role !== 'admin') {
    await logAccess({ ...actor, resource: 'users', action: 'DELETE', outcome: 'denied', detail: 'erasure attempt without admin role' });
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const userId = request.nextUrl.searchParams.get('userId') || request.nextUrl.searchParams.get('id');
  if (!userId) {
    return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
  }

  // Capture the target's identity BEFORE erasure — afterwards it's gone.
  const client = await getTypedClient();
  const targetRows = await client.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const targetEmail = targetRows[0]?.email ?? null;

  let result;
  try {
    result = await deleteUserData(userId);
  } catch (err) {
    await logAccess({
      ...actor,
      resource: 'users',
      action: 'DELETE',
      outcome: 'failure',
      detail: `erasure of user ${userId} FAILED: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    throw err;
  }
  if (!result) {
    await logAccess({ ...actor, resource: 'users', action: 'DELETE', outcome: 'error', detail: `erasure requested for unknown user ${userId}` });
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  await logAccess({ ...actor, resource: 'users', action: 'DELETE', outcome: 'success', detail: `GDPR/LGPD erasure of user ${userId} (${targetEmail ?? 'no email'})` });
  return NextResponse.json({ ok: true, deleted: result });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAlerts, getAlertById, updateAlertStatus, bulkUpdateAlertStatus, deleteClosedAlerts } from '@/lib/db/queries';
import { requireAdmin, getAdminSession, canAccessCorePlatform, isDeptScoped } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { typesForCategory } from '@/lib/alerts/categories';
import { applyAlertEvidenceRule } from '@/lib/alerts/evidence-visibility';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const params = request.nextUrl.searchParams;

  const id = params.get('id');
  if (id) {
    const alert = await getAlertById(id);
    if (!alert) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const [shown] = await applyAlertEvidenceRule(request, session, [alert]);
    return NextResponse.json(shown);
  }

  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'alerts', action: 'READ', outcome: 'success' });
  const status = params.get('status') || undefined;
  // Dept-scoped roles (cowork/pulse/code) are locked to their own department and
  // cannot bypass it via the query param. Org-wide roles (admin/viewer) are NOT
  // scoped by their own department — they see all alerts by default and may
  // optionally filter via ?department= (e.g. a manager narrowing the view).
  const department = isDeptScoped(session.role) ? (session.department || undefined) : (params.get('department') || undefined);
  const category = params.get('category') || undefined;
  const types = category ? typesForCategory(category) : [];
  const alerts = await getAlerts({ status, department, types: types.length ? types : undefined });
  return NextResponse.json(await applyAlertEvidenceRule(request, session, alerts));
}

export async function PATCH(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const body = await request.json();
  const { id, status, resolved_by, bulk_from, category } = body;

  const validStatuses = ['open', 'acknowledged', 'resolved', 'dismissed'];
  if (!status || !validStatuses.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
  }

  // Bulk update: change all alerts from one status to another
  if (bulk_from) {
    if (!validStatuses.includes(bulk_from)) {
      return NextResponse.json({ error: `Invalid bulk_from status` }, { status: 400 });
    }
    const types = category ? typesForCategory(category) : [];
    const updated = await bulkUpdateAlertStatus(bulk_from, status, resolved_by, types.length ? types : undefined);
    return NextResponse.json({ ok: true, updated });
  }

  // Single update
  if (!id) {
    return NextResponse.json({ error: 'id or bulk_from required' }, { status: 400 });
  }

  const existing = await getAlertById(id);
  if (!existing) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
  }

  await updateAlertStatus(id, status, resolved_by);
  const adminSession = await getAdminSession(request);
  await logAccess({ actorId: adminSession.userId!, actorEmail: adminSession.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'alerts', action: 'WRITE', outcome: 'success', detail: `id=${id} status=${status}` });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const deleted = await deleteClosedAlerts();
  return NextResponse.json({ ok: true, deleted });
}

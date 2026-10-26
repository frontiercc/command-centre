// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder LEFT JOINs. The PATCH handler's UPDATE + conditional INSERT
// are two independent, sequentially-awaited statements with no transaction.
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

// GET — list capability candidates (or dismissed) for admin or linked user
export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = await getTypedClient();
  const pe = schema.pulseEvents;
  const u = schema.users;
  const pc = schema.pulseClassifications;

  const scopeUser = request.nextUrl.searchParams.get('scope') === 'user';
  const statusFilter = request.nextUrl.searchParams.get('status') === 'dismissed' ? 'dismissed' : 'candidate';

  let filterUserId: string | null = null;
  if (scopeUser || session.role !== 'admin') {
    const linkedRows = await client
      .select({ linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, session.userId!))
      .limit(1);
    filterUserId = linkedRows[0]?.linked_cowork_user_id ?? null;
    if (!filterUserId) return NextResponse.json({ candidates: [], pendingCount: 0 });
  }

  const whereClause = filterUserId
    ? and(eq(pe.event_type, 'capability_creation'), eq(pe.status, statusFilter), eq(pe.user_id, filterUserId))
    : and(eq(pe.event_type, 'capability_creation'), eq(pe.status, statusFilter));

  const candidates = await client
    .select({
      id: pe.id, title: pe.title, body: pe.body, tier: pe.tier, detected_at: pe.detected_at, status: pe.status,
      user_id: pe.user_id, display_name: u.display_name, email: u.email, task_type: pc.task_type,
    })
    .from(pe)
    .leftJoin(u, eq(u.id, pe.user_id))
    .leftJoin(pc, eq(pc.cowork_message_id, pe.cowork_message_id))
    .where(whereClause)
    .orderBy(desc(pe.detected_at))
    .limit(100);

  return NextResponse.json({ candidates, pendingCount: candidates.length });
}

// PATCH — confirm, dismiss, or restore a capability event
export async function PATCH(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  interface ValueInput { valueType?: string; valueAmount?: number; valuePeriod?: string; valueBasis?: string }
  let body: { id: number; action: 'confirm' | 'dismiss' | 'restore'; value?: ValueInput };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { id, action } = body;
  if (id == null || !['confirm', 'dismiss', 'restore'].includes(action)) {
    return NextResponse.json({ error: 'id and action (confirm|dismiss|restore) required' }, { status: 400 });
  }

  // §3a: optional value attribution captured at confirmation. Never required,
  // but a `value_basis` is mandatory whenever an amount is entered (every figure
  // carries its reasoning), and the attributor's name travels with it.
  const VALUE_TYPES = ['external_spend_replaced', 'cost_avoidance', 'time_reclaimed'];
  const VALUE_PERIODS = ['one_off', 'monthly', 'annual'];
  let valueSet: Record<string, unknown> | null = null;
  // Only admins and managers attribute value: it feeds the executive "Value on
  // the table" total and the finance export, labelled manager-attributed. A
  // value sent with anyone else's self-confirm is ignored; the confirm still
  // goes through.
  if (action === 'confirm' && body.value && body.value.valueAmount != null && canAccessPulseAdmin(session.role)) {
    const v = body.value;
    if (typeof v.valueAmount !== 'number' || !Number.isFinite(v.valueAmount) || v.valueAmount < 0) {
      return NextResponse.json({ error: 'valueAmount must be a non-negative number' }, { status: 400 });
    }
    if (!v.valueType || !VALUE_TYPES.includes(v.valueType)) {
      return NextResponse.json({ error: `valueType must be one of ${VALUE_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!v.valuePeriod || !VALUE_PERIODS.includes(v.valuePeriod)) {
      return NextResponse.json({ error: `valuePeriod must be one of ${VALUE_PERIODS.join(', ')}` }, { status: 400 });
    }
    if (!v.valueBasis || typeof v.valueBasis !== 'string' || v.valueBasis.trim() === '') {
      return NextResponse.json({ error: 'value_basis is required whenever an amount is entered' }, { status: 400 });
    }
    valueSet = {
      value_type: v.valueType,
      value_amount: v.valueAmount,
      value_period: v.valuePeriod,
      value_basis: v.valueBasis.trim(),
      attributed_by: session.email,
    };
  }

  const client = await getTypedClient();
  const pe = schema.pulseEvents;
  const u = schema.users;
  const au = schema.adminUsers;
  const a = schema.alerts;

  const now = Math.floor(Date.now() / 1000);
  const newStatus = action === 'confirm' ? 'confirmed' : action === 'restore' ? 'candidate' : 'dismissed';

  const eventRows = await client
    .select({ id: pe.id, user_id: pe.user_id, title: pe.title, status: pe.status })
    .from(pe)
    .where(eq(pe.id, id));
  const event = eventRows[0];

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Non-admin users can only action their own events
  if (session.role !== 'admin') {
    const linkedRows = await client
      .select({ linked_cowork_user_id: au.linked_cowork_user_id })
      .from(au)
      .where(eq(au.id, session.userId!))
      .limit(1);
    const linked = linkedRows[0];
    if (!linked?.linked_cowork_user_id || linked.linked_cowork_user_id !== event.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // Restore only works on dismissed; confirm/dismiss only work on candidates
  if (action === 'restore' && event.status !== 'dismissed') {
    return NextResponse.json({ error: 'Can only restore dismissed events' }, { status: 400 });
  }
  if (action !== 'restore' && event.status !== 'candidate') {
    return NextResponse.json({ error: 'Event not in candidate state' }, { status: 400 });
  }

  // confirmed_at stays unchanged for non-confirm actions: the field is simply
  // omitted from `.set()` when not confirming.
  await client
    .update(pe)
    .set(action === 'confirm'
      ? { status: newStatus, confirmed_at: now, ...(valueSet ? { ...valueSet, attributed_at: now } : {}) }
      : { status: newStatus })
    .where(eq(pe.id, id));

  // Priority 5 — fire an alert when confirming a capability creation
  if (action === 'confirm') {
    const userRows = await client
      .select({ display_name: u.display_name, email: u.email })
      .from(u)
      .where(eq(u.id, event.user_id));
    const user = userRows[0];

    const userName = user?.display_name ?? user?.email ?? 'Unknown user';

    // Check if pulse_capability alerts are enabled — default OFF (they appear in Pulse UI already)
    const capabilityAlertsEnabled = (await getConfigValue('riskAlertPulseCapabilityEnabled')) === 'true';

    if (capabilityAlertsEnabled) {
      await client.insert(a).values({
        id: randomUUID(),
        user_id: event.user_id,
        alert_type: 'pulse_capability',
        severity: 'low',
        title: `Capability confirmed: ${userName}`,
        explanation: `${userName} has a confirmed capability creation event: "${event.title}"`,
        status: 'open',
        generated_at: now,
      });
      // Notify sidebar badge
    }
  }

  return NextResponse.json({ ok: true, status: newStatus });
}

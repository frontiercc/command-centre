// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// onConflictDoUpdate for the two upserts (preserving the exact ON CONFLICT
// clause — only the touched columns are updated, so an existing target_dds
// survives a pulse_start_at-only write and vice versa). Timestamps come from
// the app clock. Each upsert is a single statement, so it is a single awaited
// call with no withTx.
import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

async function resolveUserId(request: NextRequest, session: Awaited<ReturnType<typeof getAdminSession>>): Promise<string | null> {
  const client = await getTypedClient();
  const queryUserId = request.nextUrl.searchParams.get('userId');
  if (queryUserId && canAccessPulseAdmin(session.role)) {
    return queryUserId;
  }
  const au = schema.adminUsers;
  const u = schema.users;
  // Check linked_cowork_user_id first, fall back to email match
  const linkedRows = await client
    .select({ linked_cowork_user_id: au.linked_cowork_user_id })
    .from(au)
    .where(eq(au.email, session.email!))
    .limit(1);
  const linked = linkedRows[0];
  if (linked?.linked_cowork_user_id) return linked.linked_cowork_user_id;
  const byEmailRows = await client.select({ id: u.id }).from(u).where(eq(u.email, session.email!)).limit(1);
  return byEmailRows[0]?.id ?? null;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await resolveUserId(request, session);
  if (!userId) {
    return NextResponse.json({ target_dds: null, pulse_start_at: null });
  }

  const client = await getTypedClient();
  const pup = schema.pulseUserPrefs;
  const prefsRows = await client
    .select({ target_dds: pup.target_dds, pulse_start_at: pup.pulse_start_at })
    .from(pup)
    .where(eq(pup.user_id, userId));
  const prefs = prefsRows[0];

  return NextResponse.json({
    target_dds: prefs?.target_dds ?? null,
    pulse_start_at: prefs?.pulse_start_at ?? null,
  });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await resolveUserId(request, session);
  if (!userId) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  let body: { target_dds?: number | null; pulse_start_at?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const client = await getTypedClient();
  const pup = schema.pulseUserPrefs;
  const now = Math.floor(Date.now() / 1000); // app clock

  if ('target_dds' in body) {
    const { target_dds } = body;
    if (target_dds !== null && target_dds !== undefined &&
        (typeof target_dds !== 'number' || target_dds < 1 || target_dds > 3)) {
      return NextResponse.json({ error: 'target_dds must be null or 1–3' }, { status: 400 });
    }
    await client
      .insert(pup)
      .values({ user_id: userId, target_dds: target_dds ?? null, set_at: now })
      .onConflictDoUpdate({
        target: pup.user_id,
        set: { target_dds: sql`excluded.target_dds`, set_at: sql`excluded.set_at` },
      });
  }

  if ('pulse_start_at' in body) {
    if (!canAccessPulseAdmin(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const raw = body.pulse_start_at;
    let startEpoch: number | null = null;
    if (raw !== null && raw !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return NextResponse.json({ error: 'pulse_start_at must be YYYY-MM-DD or null' }, { status: 400 });
      }
      startEpoch = Math.floor(new Date(`${raw}T00:00:00Z`).getTime() / 1000);
    }
    await client
      .insert(pup)
      .values({ user_id: userId, target_dds: null, set_at: now, pulse_start_at: startEpoch })
      .onConflictDoUpdate({
        target: pup.user_id,
        set: { pulse_start_at: sql`excluded.pulse_start_at`, set_at: sql`excluded.set_at` },
      });
  }

  return NextResponse.json({ ok: true });
}

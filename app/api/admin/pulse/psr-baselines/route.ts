// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// suggestBaselineProcessCount (lib/pulse/metrics/psr.ts) is async and
// awaited. The two POST writes (auto-upsert the FK'd users row,
// then the pulse_baselines ON CONFLICT upsert) are two independent
// statements (no surrounding transaction), sequentially awaited — no
// withTx. `onConflictDoNothing()` / `onConflictDoUpdate()` carry the
// insert-or-ignore and ON CONFLICT(team_id) DO UPDATE clauses.
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { suggestBaselineProcessCountForDept } from '@/lib/pulse/metrics/psr';

export const dynamic = 'force-dynamic';

// Field names kept as teamId/teamName for response-shape stability (this
// route's only consumer, PsrBaselines.tsx, keys off these) — the VALUE is
// now a department name, not users.team_id. The
// team_id column exists but nothing in the app ever populates it, so PSR
// switched to admin_users.department (already populated by every OTel-
// enrolled user via the receivers' auto-admin-user-creation), matching the
// already-existing computeDeptPsr/suggestBaselineProcessCountForDept path.
interface TeamBaselineRow {
  teamId: string;
  teamName: string;
  baselineProcessCount: number | null;
  suggestion: number;
  confirmedCapabilities: number;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  const client = await getTypedClient();
  const au = schema.adminUsers;
  const pb = schema.pulseBaselines;
  const pe = schema.pulseEvents;

  const deptRows = await client
    .selectDistinct({ department: au.department })
    .from(au)
    .where(and(isNotNull(au.department), ne(au.department, '')))
    .orderBy(asc(au.department));

  const teams: TeamBaselineRow[] = await Promise.all(deptRows.map(async ({ department }) => {
    const dept = department as string;
    const baselineRows = await client
      .select({ baseline_process_count: pb.baseline_process_count })
      .from(pb)
      .where(eq(pb.team_id, dept))
      .limit(1);

    const confirmedRows = await client
      .select({ cnt: schema.pulseEvents.id })
      .from(pe)
      .innerJoin(au, eq(au.linked_cowork_user_id, pe.user_id))
      .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'), eq(au.department, dept)));

    return {
      teamId: dept,
      teamName: dept,
      baselineProcessCount: baselineRows[0]?.baseline_process_count ?? null,
      suggestion: await suggestBaselineProcessCountForDept(dept),
      confirmedCapabilities: confirmedRows.length,
    };
  }));

  return NextResponse.json({ teams });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  let body: { teamId?: string; baselineProcessCount?: number | string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const teamId = body?.teamId;
  if (!teamId || typeof teamId !== 'string') {
    return NextResponse.json({ error: 'teamId is required' }, { status: 400 });
  }

  const raw = body?.baselineProcessCount;
  let baselineProcessCount: number | null;

  if (raw === null || raw === undefined || raw === '') {
    baselineProcessCount = null;
  } else {
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return NextResponse.json(
        { error: 'baselineProcessCount must be a non-negative integer, or null to clear' },
        { status: 400 }
      );
    }
    baselineProcessCount = parsed;
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  let setBy = session.userId ?? session.email ?? 'admin';

  // Auto-upsert the user row so the FK on pulse_baselines.set_by never blocks a
  // save from a valid admin session (admin_users and users are separate
  // keyspaces). session.userId is the admin_users.id — but on any real
  // deployment the admin is very likely ALSO an OTel-captured Cowork/Code
  // user, meaning a users row for their email already exists under a
  // DIFFERENT id. Inserting a new row keyed by session.userId with that same
  // real email then silently no-ops (ON CONFLICT DO NOTHING absorbs the
  // email-uniqueness conflict too, not just an id conflict), leaving
  // set_by pointing at a users.id that was never created and the second
  // insert below failing its FK. Prefer the existing row for that email.
  if (session.email) {
    const existingByEmail = await client
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, session.email))
      .limit(1);
    if (existingByEmail[0]) {
      setBy = existingByEmail[0].id;
    } else {
      await client
        .insert(schema.users)
        .values({ id: setBy, display_name: session.displayName ?? setBy, email: session.email, created_at: now })
        .onConflictDoNothing();
    }
  } else {
    await client
      .insert(schema.users)
      .values({ id: setBy, display_name: session.displayName ?? setBy, email: setBy, created_at: now })
      .onConflictDoNothing();
  }

  await client
    .insert(schema.pulseBaselines)
    .values({ team_id: teamId, baseline_process_count: baselineProcessCount, set_by: setBy, set_at: now })
    .onConflictDoUpdate({
      target: schema.pulseBaselines.team_id,
      set: {
        baseline_process_count: baselineProcessCount,
        set_by: setBy,
        set_at: now,
      },
    });

  return NextResponse.json({ ok: true, teamId, baselineProcessCount });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Only 2
// simple selects (RBAC dept-scope check) through the query builder, so no
// rawAll is needed.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCoworkPulse, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getPerson360 } from '@/lib/pulse/person';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { getAllConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * RBAC gate copied from /api/pulse/me (the canonical "view another user's
 * Pulse data" check): admin/manager can view anyone; dept-scoped roles
 * (cowork/pulse/code) may only view users in their own department; other
 * roles are forbidden. Person 360 spans both Cowork and Developer Pulse data, so
 * canAccessCoworkPulse is used as the base gate (widest of the two surface
 * gates — canAccessCodePulse allows the same admin/manager/viewer roles).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const userId = decodeURIComponent((await params).userId);

  if (isDeptScoped(session.role)) {
    if (!session.department) {
      return NextResponse.json(
        { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
        { status: 422 }
      );
    }
    const client = await getTypedClient();
    const targetAdminRows = await client
      .select({ department: schema.adminUsers.department })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.linked_cowork_user_id, userId))
      .limit(1);
    const targetUserRows = await client
      .select({ department: schema.users.department })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const targetDept = targetAdminRows[0]?.department ?? targetUserRows[0]?.department ?? null;
    if (targetDept !== session.department) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  try {
    const data = await getPerson360(userId);
    // Person-level human time: admins and managers for anyone,
    // everyone else only on their own page (a same-department colleague's page
    // does not carry it). "Own" = the linked account, else the same email.
    let seesPerson = canAccessPulseAdmin(session.role);
    if (!seesPerson) {
      const client = await getTypedClient();
      const linked = session.userId
        ? await client.select({ id: schema.adminUsers.linked_cowork_user_id }).from(schema.adminUsers)
          .where(eq(schema.adminUsers.id, session.userId)).limit(1)
        : [];
      const byEmail = session.email
        ? await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, session.email)).limit(1)
        : [];
      seesPerson = (linked[0]?.id ?? byEmail[0]?.id ?? null) === userId;
    }
    const humanTime = seesPerson
      ? { cowork: await readHumanTime('cowork', [userId]), code: await readHumanTime('code', [userId]) }
      : null;
    // The same people may open this person's Spend Review (lib/finance/spend-review-access.ts),
    // which lives under FinOps and is hidden with it.
    const canSeeSpendReview = seesPerson && (await getAllConfig()).chargebackEnabled === true;
    return NextResponse.json({ ...data, humanTime, canSeeSpendReview });
  } catch (err) {
    console.error('[Person360] Failed to load Person 360 for', userId, err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

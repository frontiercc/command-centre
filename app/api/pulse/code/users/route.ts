// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Developer Pulse Users list. Built by lib/pulse/code/users-list.ts.
import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { sql } from 'drizzle-orm';
import { getAdminSession, canAccessCodePulse, isDeptScoped, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { keptFigures } from '@/lib/kept-figures';
import { buildCodeUsersList, rawAll } from '@/lib/pulse/code/users-list';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCodePulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (isDeptScoped(session.role) && !session.department) {
    return NextResponse.json(
      { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
      { status: 422 }
    );
  }

  // Contributor roles (code, pulse) are always scoped to their own department
  const dept = isDeptScoped(session.role)
    ? (session.department ?? null)
    : request.nextUrl.searchParams.get('dept');

  // Developer Pulse's All / Claude / Codex switch.
  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));

  // The list is the same for every viewer of this department and view, so it is kept and
  // refreshed in the background every few minutes (lib/kept-figures.ts); what each viewer may see
  // of it is decided below, on every request.
  const { rows, codexPresent } = await keptFigures(`code-users:${dept ?? ''}:${vendor}`, () => buildCodeUsersList(dept, vendor), {
    force: request.nextUrl.searchParams.get('fresh') === '1',
  });

  // Each person's spend: admins and managers see everyone's. Anyone else gets only their own, with
  // the list in name order, so neither a figure nor the order says what a colleague spent.
  if (!canAccessPulseAdmin(session.role)) {
    const mine = await rawAll<{ id: string }>(await getTypedClient(), sql`
      SELECT COALESCE(
        (SELECT linked_cowork_user_id FROM admin_users WHERE id = ${session.userId ?? ''} LIMIT 1),
        (SELECT id FROM users WHERE email = ${session.email ?? ''} LIMIT 1)
      ) AS id
    `);
    const me = mine[0]?.id ?? null;
    const hidden = rows
      .map(r => (r.user_id === me ? r : { ...r, spend_usd: null, spend_hidden: true }))
      .sort((a, b) => (a.display_name ?? a.email ?? '').localeCompare(b.display_name ?? b.email ?? ''));
    return NextResponse.json({ users: hidden, vendor, codexPresent });
  }
  return NextResponse.json({ users: rows, vendor, codexPresent });
}

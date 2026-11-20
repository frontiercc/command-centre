// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Work Pulse Users list. Built by lib/pulse/users-list.ts.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessCoworkPulse, isDeptScoped } from '@/lib/auth/admin-auth';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { keptFigures } from '@/lib/kept-figures';
import { buildUsersList } from '@/lib/pulse/users-list';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Allow all roles with Work Pulse access
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // cowork must have a department to access user lists
  if (isDeptScoped(session.role) && !session.department) {
    return NextResponse.json(
      { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
      { status: 422 }
    );
  }

  const rawDept = request.nextUrl.searchParams.get('dept') || undefined;
  // cowork role: always filter to own department regardless of query param
  // (Note: canAccessPulseAdmin does NOT include cowork, so in practice this
  //  branch only fires if isDeptScoped is called independently on a cowork session
  //  that somehow reaches this route. But it's safe to include for defence-in-depth.)
  const deptFilter: string | undefined = isDeptScoped(session.role)
    ? (session.department ?? undefined)
    : rawDept;

  // Work Pulse's switch: a vendor view reads that vendor's own figures, as the
  // person's page does (app/api/pulse/me). Without the parameter, all products.
  const vendorParam = request.nextUrl.searchParams.get('vendor');
  const vendor = vendorParam ? await visibleVendor(vendorParam) : 'all';
  // The same for every viewer who reaches this point, so kept and refreshed in the background
  // every few minutes (lib/kept-figures.ts): a visit reads the kept result.
  return NextResponse.json(await keptFigures(`pulse-users:${deptFilter ?? ''}:${vendor}`, () => buildUsersList(deptFilter, vendor), {
    force: request.nextUrl.searchParams.get('fresh') === '1',
  }));
}

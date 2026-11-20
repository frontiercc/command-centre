// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse's organisation-wide figures. They are the same for every viewer the role check
// lets in, so they are built by lib/pulse/code/org-summary.ts, kept, and refreshed in the
// background every few minutes (lib/kept-figures.ts): a visit reads the kept result.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { keptFigures } from '@/lib/kept-figures';
import { buildCodeOrgSummary } from '@/lib/pulse/code/org-summary';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
    return NextResponse.json(await keptFigures(`code-org-summary:${vendor}`, () => buildCodeOrgSummary(vendor), {
      force: request.nextUrl.searchParams.get('fresh') === '1',
    }));
  } catch (err) {
    return errorResponse('pulse/code/org-summary', err);
  }
}

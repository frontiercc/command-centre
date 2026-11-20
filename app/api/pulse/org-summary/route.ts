// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse's organisation-wide figures. They are the same for every viewer the role check lets
// in, so they are built by lib/pulse/org-summary.ts, kept, and refreshed in the background every
// few minutes (lib/kept-figures.ts): a visit reads the kept result.
import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { keptFigures } from '@/lib/kept-figures';
import { errorResponse } from '@/lib/api/errors';
import { buildOrgSummary, keepOrgSummary } from '@/lib/pulse/org-summary';

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
    const quarterly = request.nextUrl.searchParams.get('window') === 'quarter';
    // A result with a section that failed to build is shown but not kept.
    const body = await keptFigures(
      `org-summary:${vendor}:${quarterly ? 'quarter' : '30d'}`,
      () => buildOrgSummary(vendor, quarterly),
      { keep: keepOrgSummary, force: request.nextUrl.searchParams.get('fresh') === '1' },
    );
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse('pulse/org-summary', err);
  }
}

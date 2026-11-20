// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { buildStickinessView } from '@/lib/pulse/stickiness';
import { keptFigures } from '@/lib/kept-figures';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  // Kept and refreshed in the background every few minutes (lib/kept-figures.ts).
  return NextResponse.json(await keptFigures(`stickiness:${vendor}`, () => buildStickinessView(vendor), {
    force: request.nextUrl.searchParams.get('fresh') === '1',
  }));
}

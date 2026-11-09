// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getProductStickiness, getStickinessByProduct } from '@/lib/pulse/stickiness';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const [{ cowork, code, chat }, products] = await Promise.all([
    getProductStickiness(undefined, vendor),
    getStickinessByProduct(),
  ]);

  return NextResponse.json({
    cowork,
    code,
    chat,
    // Each of the six products on its own, for the dashboard's split view.
    products,
    computedAt: Math.floor(Date.now() / 1000),
  });
}

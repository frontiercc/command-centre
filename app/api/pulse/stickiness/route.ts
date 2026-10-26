// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getProductStickiness } from '@/lib/pulse/stickiness';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { cowork, code, chat } = await getProductStickiness();

  return NextResponse.json({
    cowork,
    code,
    chat,
    computedAt: Math.floor(Date.now() / 1000),
  });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { disableTotp, findAdminById } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin role required' }, { status: 403 });
  }

  const { id } = await params;
  const target = await findAdminById(id);
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  await disableTotp(id);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
  await logAuthEvent({
    eventType: 'mfa_disabled',
    ipAddress: ip,
    details: JSON.stringify({ resetBy: session.userId, targetUserId: id, targetEmail: target.email }),
  });

  return NextResponse.json({ success: true });
}

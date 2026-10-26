// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { verifyPassword } from '@/lib/auth/admin-auth';
import { disableTotp, findAdminById } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body as { password?: string };

  if (!password) {
    return NextResponse.json({ error: 'password_required', message: 'Password is required to disable MFA' }, { status: 400 });
  }

  // Re-verify password before disabling MFA
  const user = await findAdminById(session.userId);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: 'invalid_password', message: 'Incorrect password' }, { status: 401 });
  }

  await disableTotp(session.userId);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
  await logAuthEvent({
    eventType: 'mfa_disabled',
    ipAddress: ip,
    details: JSON.stringify({ userId: session.userId, email: session.email }),
  });

  return NextResponse.json({ success: true });
}

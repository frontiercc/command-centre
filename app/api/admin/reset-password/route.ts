// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { consumePasswordResetToken } from '@/lib/db/admin-queries';
import { updateAdminPasswordAndSso, deleteUserSessions } from '@/lib/db/admin-queries';
import { hashPassword } from '@/lib/auth/admin-auth';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string };
  try {
    body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { token, password } = body;

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'token_required' }, { status: 400 });
  }

  if (!password || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: 'invalid_password', message: PASSWORD_TOO_SHORT },
      { status: 400 }
    );
  }

  const result = await consumePasswordResetToken(token);
  if (!result) {
    return NextResponse.json(
      { error: 'invalid_token', message: 'This reset link is invalid or has expired.' },
      { status: 400 }
    );
  }

  // Reachable unauthenticated via forgot-password. Deliberate: completing an
  // email-verified reset on an auto-enrolled (sentinel) account activates it —
  // password + SSO eligibility together, same rule as the migration-055
  // backfill. SSO grants nothing beyond the password set here: proving control
  // of the corporate inbox already grants a password login (pre-existing
  // behavior), and the IdP must assert the same email to use SSO instead.
  await updateAdminPasswordAndSso(result.userId, hashPassword(password));
  await deleteUserSessions(result.userId);

  return NextResponse.json({ ok: true });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { getAdminSession } from '@/lib/auth/admin-auth';
import {
  generateTotpSecret,
  getTotpUri,
  verifyTotpCode,
  generateRecoveryCodes,
} from '@/lib/auth/totp';
import { enableTotp, getTotpStatus } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';

export const dynamic = 'force-dynamic';

// GET /api/admin/mfa/setup — generate a new secret and QR code (not yet saved)
export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = await getTotpStatus(session.userId);
  if (status.enabled) {
    return NextResponse.json({ error: 'MFA is already enabled' }, { status: 400 });
  }

  const secret = generateTotpSecret();
  const uri = getTotpUri(session.email!, secret);
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 200, margin: 2 });

  return NextResponse.json({ secret, qrDataUrl });
}

// POST /api/admin/mfa/setup — verify the first code, then enable MFA and return recovery codes
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = await getTotpStatus(session.userId);
  if (status.enabled) {
    return NextResponse.json({ error: 'MFA is already enabled' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { secret, code } = body as { secret?: string; code?: string };

  if (!secret || !code) {
    return NextResponse.json({ error: 'secret and code are required' }, { status: 400 });
  }

  // Verify the code against the provided secret BEFORE saving anything
  if (!verifyTotpCode(code, secret)) {
    return NextResponse.json({ error: 'invalid_code', message: 'Incorrect code. Please try again' }, { status: 400 });
  }

  // Code is valid — generate recovery codes and save
  const { raw, hashed } = generateRecoveryCodes(10);
  await enableTotp(session.userId, secret, hashed);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
  await logAuthEvent({
    eventType: 'mfa_enabled',
    ipAddress: ip,
    details: JSON.stringify({ userId: session.userId, email: session.email }),
  });

  return NextResponse.json({ recoveryCodes: raw });
}

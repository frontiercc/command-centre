// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/auth/sso/meta — PUBLIC, unauthenticated (see middleware.ts
// SELF_AUTH_API_PREFIXES). The login page needs to know whether to render an
// "SSO" button and what to label it BEFORE the user is signed in, so this
// has to be reachable with no session. It must therefore leak NOTHING but
// the two fields a logged-out visitor is already allowed to infer from the
// login page's own rendering — never issuer URL, client ID, or any other
// piece of getOidcSettings()'s output.
import { NextResponse } from 'next/server';
import { getOidcSettings } from '@/lib/auth/oidc';
import { getAllConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getOidcSettings();
  if (settings === null) {
    // Not enabled/configured: never leak whatever custom label an admin may
    // have typed in before disabling SSO — always report the default.
    return NextResponse.json({ enabled: false, label: 'SSO' });
  }
  return NextResponse.json({
    enabled: true,
    label: (await getAllConfig()).ssoProviderLabel,
  });
}

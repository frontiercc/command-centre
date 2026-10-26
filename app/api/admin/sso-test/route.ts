// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Admin "Test connection" button on the SSO config card (/admin/security).
// Runs OIDC discovery server-side against either the currently-saved config
// or an in-flight override the admin hasn't saved yet, and reports the
// outcome. Never echoes the client secret back — only the discovered issuer
// identifier on success, or a short error message on failure.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { testOidcDiscovery } from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

interface SsoTestBody {
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Admin role required' },
      { status: 403 }
    );
  }

  let body: SsoTestBody = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is valid — test against the currently-saved config.
    body = {};
  }

  const override =
    body.issuerUrl || body.clientId || body.clientSecret
      ? {
          issuerUrl: body.issuerUrl,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
        }
      : undefined;

  const result = await testOidcDiscovery(override);
  return NextResponse.json(result);
}

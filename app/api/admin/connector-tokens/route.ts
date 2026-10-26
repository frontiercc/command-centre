// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * CCC Metrics Connector — admin token management.
 *
 * Thin admin-only wrapper over lib/connector/tokens.ts. GET lists tokens
 * (never the plaintext) plus the endpoint URLs the admin card displays.
 * POST mints a new token — the ONLY response in this whole surface that
 * ever contains the plaintext secret; it is never persisted or returned
 * again. DELETE?id= revokes a token (idempotent — false if unknown/already
 * revoked, matching lib/connector/tokens.ts).
 *
 * Auth pattern matches app/api/admin/digest/route.ts: getAdminSession for
 * GET (401 unauthenticated / 403 non-admin), requireAdmin for the
 * mutating verbs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getConfigValue } from '@/lib/config';
import { getAdminSession, requireAdmin } from '@/lib/auth/admin-auth';
import { mintConnectorToken, listConnectorTokens, revokeConnectorToken } from '@/lib/connector/tokens';

const MAX_NAME_LENGTH = 100;

function buildEndpoints(hubUrl: string) {
  return {
    mcp: `${hubUrl}/api/mcp`,
    exportSummary: `${hubUrl}/api/export/summary`,
    exportTrends: `${hubUrl}/api/export/trends`,
    exportHealth: `${hubUrl}/api/export/health`,
  };
}

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const hubUrl = (await getConfigValue('digestHubUrl')) || 'http://localhost:3001';
    return NextResponse.json({
      tokens: await listConnectorTokens(),
      endpoints: buildEndpoints(hubUrl),
    });
  } catch (err) {
    return errorResponse('api/admin/connector-tokens', err);
  }
}

export async function POST(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `name must be between 1 and ${MAX_NAME_LENGTH} characters` },
      { status: 400 }
    );
  }

  try {
    const { token, record } = await mintConnectorToken(name);
    return NextResponse.json({ token, record });
  } catch (err) {
    return errorResponse('api/admin/connector-tokens', err);
  }
}

export async function DELETE(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
  }

  try {
    const revoked = await revokeConnectorToken(id);
    return NextResponse.json({ revoked });
  } catch (err) {
    return errorResponse('api/admin/connector-tokens', err);
  }
}

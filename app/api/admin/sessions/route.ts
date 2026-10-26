// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, SESSION_COOKIE_NAME } from '@/lib/auth/admin-auth';
import { listActiveSessions, deleteSession, deleteUserSessions, hashSessionToken } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';

export const dynamic = 'force-dynamic';

// ─── GET /api/admin/sessions — list all active sessions ──────────────────────

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Stored ids are hashes of the cookie tokens, so hash the caller's cookie to compare.
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const currentId = cookie ? hashSessionToken(cookie) : null;
  const sessions = (await listActiveSessions()).map(s => ({
    id: s.id,
    userId: s.user_id,
    email: s.email,
    displayName: s.display_name,
    role: s.role,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    ipAddress: s.ip_address,
    userAgent: s.user_agent,
    isCurrent: s.id === currentId,
  }));

  return NextResponse.json({ sessions });
}

// ─── DELETE /api/admin/sessions — revoke a session ───────────────────────────

export async function DELETE(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { sessionId, userId } = await request.json().catch(() => ({}));

  // Revoke all sessions for a user
  if (userId) {
    const count = await deleteUserSessions(userId);
    await logAuthEvent({
      eventType: 'admin_sessions_revoked',
      details: JSON.stringify({ targetUserId: userId, count, revokedBy: session.email }),
    });
    return NextResponse.json({ revoked: count });
  }

  // Revoke a single session
  if (sessionId) {
    // Prevent revoking your own current session via this endpoint
    const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (cookie && sessionId === hashSessionToken(cookie)) {
      return NextResponse.json(
        { error: 'cannot_revoke_own_session', message: 'Use logout to end your own session' },
        { status: 409 }
      );
    }
    const ok = await deleteSession(sessionId);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    await logAuthEvent({
      eventType: 'admin_session_revoked',
      details: JSON.stringify({ sessionId, revokedBy: session.email }),
    });
    return NextResponse.json({ revoked: 1 });
  }

  return NextResponse.json({ error: 'sessionId or userId required' }, { status: 400 });
}

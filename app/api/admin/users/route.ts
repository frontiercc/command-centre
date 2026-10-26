// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { asc, sql } from 'drizzle-orm';
import { getAdminSession, requireAdmin, hashPassword } from '@/lib/auth/admin-auth';
import type { UserRole } from '@/lib/auth/admin-auth';
import {
  listAdminUsers,
  createAdminUser,
  findAdminByEmail,
  AdminUserRow,
} from '@/lib/db/admin-queries';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { logAuthEvent } from '@/lib/db/auth-events';
import { logAccess } from '@/lib/audit/log';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

// ─── Safe user shape (no password_hash) ──────────────────────────────────────

function toSafeUser(user: AdminUserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    department: user.department ?? null,
    linkedCoworkUserId: user.linked_cowork_user_id ?? null,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
    totpEnabled: user.totp_enabled === 1,
    otelPending: user.password_hash === '__otel_pending__',
    // SSO admin card / accounts table: server-computed provenance + eligibility.
    // NEVER derive these on the client — password_hash itself never leaves this function.
    autoEnrolled: user.password_hash === '__otel_pending__',
    ssoEnabled: user.sso_enabled === 1,
  };
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json(
      { error: 'unauthenticated', message: 'Authentication required' },
      { status: 401 }
    );
  }
  if (session.role !== 'admin') {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/users', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/users', action: 'READ', outcome: 'success' });

  const users = await listAdminUsers();
  // Also return the people in telemetry, for the Access & Keys page's "Linked person" dropdown.
  // NULLS FIRST spelled out explicitly — Postgres's ASC default sorts NULLs
  // LAST, and the dropdown lists unnamed people first.
  const client = await getTypedClient();
  const agents = await client
    .select({ id: schema.users.id, display_name: schema.users.display_name })
    .from(schema.users)
    .orderBy(sql`${schema.users.display_name} ASC NULLS FIRST`, asc(schema.users.id));
  return NextResponse.json({ users: users.map(toSafeUser), agents });
}

// ─── POST /api/admin/users ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Admin role required' },
      { status: 403 }
    );
  }

  let body: { email?: string; password?: string; displayName?: string; role?: string; department?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const { email, password, displayName, role, department } = body;

  if (!email) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'Email is required' },
      { status: 400 }
    );
  }

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: 'invalid_password', message: PASSWORD_TOO_SHORT },
      { status: 400 }
    );
  }

  const VALID_ROLES: UserRole[] = ['admin', 'viewer', 'manager', 'cowork', 'code', 'pulse'];
  if (!role || !VALID_ROLES.includes(role as UserRole)) {
    return NextResponse.json(
      { error: 'invalid_role', message: "Role must be 'admin', 'viewer', 'manager', 'cowork', 'code', or 'pulse'" },
      { status: 400 }
    );
  }

  const existing = await findAdminByEmail(email);
  if (existing) {
    return NextResponse.json(
      { error: 'email_exists', message: 'Email already registered' },
      { status: 409 }
    );
  }

  const passwordHash = hashPassword(password);
  const created = await createAdminUser({
    email,
    passwordHash,
    displayName: displayName ?? null,
    role: role as UserRole,
    department: role !== 'admin' ? (department ?? null) : null,
  });

  await logAuthEvent({
    eventType: 'admin_user_created',
    details: JSON.stringify({ email, role, createdBy: session.email }),
  });

  return NextResponse.json({ user: toSafeUser(created) }, { status: 201 });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, hashPassword } from '@/lib/auth/admin-auth';
import type { UserRole } from '@/lib/auth/admin-auth';
import {
  listAdminUsers,
  findAdminById,
  updateAdminRole,
  updateAdminPasswordAndSso,
  updateAdminDepartment,
  updateAdminLinkedAgent,
  updateAdminSsoEnabled,
  deleteUserSessions,
  deleteAdminUser,
  AdminUserRow,
} from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

export const dynamic = 'force-dynamic';

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
    autoEnrolled: user.password_hash === '__otel_pending__',
    ssoEnabled: user.sso_enabled === 1,
  };
}

// ─── PATCH /api/admin/users/[id] ─────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Admin role required' },
      { status: 403 }
    );
  }

  const { id } = await params;

  let body: { role?: string; password?: string; department?: string | null; linkedCoworkUserId?: string | null; sso_enabled?: 0 | 1 };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const { role, password, department, linkedCoworkUserId, sso_enabled: ssoEnabledInput } = body;

  if (!role && !password && department === undefined && linkedCoworkUserId === undefined && ssoEnabledInput === undefined) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'At least one of role, password, department, linkedCoworkUserId, or sso_enabled is required' },
      { status: 400 }
    );
  }

  if (ssoEnabledInput !== undefined && ssoEnabledInput !== 0 && ssoEnabledInput !== 1) {
    return NextResponse.json(
      { error: 'invalid_sso_enabled', message: 'sso_enabled must be 0 or 1' },
      { status: 400 }
    );
  }

  const target = await findAdminById(id);
  if (!target) {
    return NextResponse.json(
      { error: 'not_found', message: 'User not found' },
      { status: 404 }
    );
  }

  if (role !== undefined) {
    const VALID_ROLES: UserRole[] = ['admin', 'viewer', 'manager', 'cowork', 'code', 'pulse'];
    if (!VALID_ROLES.includes(role as UserRole)) {
      return NextResponse.json(
        { error: 'invalid_role', message: "Role must be 'admin', 'viewer', 'manager', 'cowork', 'code', or 'pulse'" },
        { status: 400 }
      );
    }
    // Protect last admin from being demoted to any non-admin role
    if (role !== 'admin' && target.role === 'admin') {
      const adminCount = (await listAdminUsers()).filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'last_admin', message: 'Cannot change the role of the last admin user' },
          { status: 409 }
        );
      }
    }
    await updateAdminRole(id, role as UserRole);
    await logAuthEvent({
      eventType: 'admin_role_updated',
      details: JSON.stringify({ targetUserId: id, targetEmail: target.email, newRole: role, updatedBy: session.email }),
    });
  }

  if (department !== undefined) {
    await updateAdminDepartment(id, department ?? null);
  }

  if (linkedCoworkUserId !== undefined) {
    await updateAdminLinkedAgent(id, linkedCoworkUserId ?? null);
  }

  if (ssoEnabledInput !== undefined) {
    await updateAdminSsoEnabled(id, ssoEnabledInput === 1);
    await logAuthEvent({
      eventType: 'admin_sso_enabled_updated',
      details: JSON.stringify({ targetUserId: id, targetEmail: target.email, ssoEnabled: ssoEnabledInput === 1, updatedBy: session.email }),
    });
  }

  if (password !== undefined) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: 'invalid_password', message: PASSWORD_TOO_SHORT },
        { status: 400 }
      );
    }

    await updateAdminPasswordAndSso(id, hashPassword(password));
    await deleteUserSessions(id);
    await logAuthEvent({
      eventType: 'admin_password_updated',
      details: JSON.stringify({ targetUserId: id, targetEmail: target.email, updatedBy: session.email }),
    });
  }

  const updated = (await findAdminById(id)) as AdminUserRow;
  return NextResponse.json({ user: toSafeUser(updated) });
}

// ─── DELETE /api/admin/users/[id] ────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Admin role required' },
      { status: 403 }
    );
  }

  const { id } = await params;

  // Cannot delete yourself
  if (session.userId === id) {
    return NextResponse.json(
      { error: 'cannot_delete_self', message: 'You cannot delete your own account' },
      { status: 409 }
    );
  }

  const target = await findAdminById(id);
  if (!target) {
    return NextResponse.json(
      { error: 'not_found', message: 'User not found' },
      { status: 404 }
    );
  }

  // Cannot delete the last admin
  if (target.role === 'admin') {
    const adminCount = (await listAdminUsers()).filter(u => u.role === 'admin').length;
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: 'last_admin', message: 'Cannot delete the last admin user' },
        { status: 409 }
      );
    }
  }

  await deleteUserSessions(id);
  await deleteAdminUser(id);

  await logAuthEvent({
    eventType: 'admin_user_deleted',
    details: JSON.stringify({ targetUserId: id, targetEmail: target.email, deletedBy: session.email }),
  });

  return NextResponse.json({ success: true });
}

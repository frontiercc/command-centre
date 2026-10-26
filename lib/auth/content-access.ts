// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Shared gate for the routes that return prompt content (the Audit Log's
// conversation views). Same rule as GET /api/events: admin or manager only
// (viewers excluded), and a department-scoped caller only ever sees rows belonging to users
// in their own department. Department is resolved the same way the events
// route does — COALESCE(admin_users.department, users.department).
import { NextRequest, NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAdminSession, canAccessAuditLog, type AdminSessionResult } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';

type AuthedSession = AdminSessionResult & { authenticated: true };

/**
 * Returns the session when the caller may read prompt content, otherwise the
 * 401/403 response to send. Every outcome is written to the access audit log.
 */
export async function gateContentRead(
  request: NextRequest,
  resource: string,
  opts: { adminOnly?: boolean } = {},
): Promise<{ session: AuthedSession } | { response: NextResponse }> {
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  const detail = request.nextUrl.search || undefined;
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    await logAccess({ actorId: 'unauthenticated', actorEmail: 'unknown', actorIp, resource, action: 'READ', outcome: 'denied', detail });
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const allowed = opts.adminOnly ? session.role === 'admin' : canAccessAuditLog(session.role);
  if (!allowed) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource, action: 'READ', outcome: 'denied', detail });
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  // A manager reads prompts for their own department only, so a manager with
  // no department reads none until an admin sets one.
  if (lacksDepartment(session)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource, action: 'READ', outcome: 'denied', detail: 'no_department' });
    return { response: noDepartmentResponse() };
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource, action: 'READ', outcome: 'success', detail });
  return { session: session as AuthedSession };
}

/** True for a caller who is not an admin and has no department. */
export function lacksDepartment(session: AdminSessionResult): boolean {
  return session.authenticated && session.role !== 'admin' && !session.department;
}

/** The refusal sent to a manager with no department on a prompt-content route. */
export function noDepartmentResponse(): NextResponse {
  return NextResponse.json(
    { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
    { status: 403 },
  );
}

/**
 * The department a scoped caller is locked to, or null for an admin. Every
 * other caller reaching here has a department: gateContentRead refuses one
 * without.
 */
export function scopedDepartment(session: AuthedSession): string | null {
  if (session.role === 'admin') return null;
  return session.department || null;
}

/**
 * For routes that are open to more roles than the Audit Log but carry a few
 * prompt snippets beside other data (the executive capability log, a person's
 * capability candidates, the Pulse admin user drill-down): which of these
 * users' prompt text this caller may see. Same rule as gateContentRead +
 * scopedDepartment: admins see everyone, managers everyone in their own
 * department (nobody when they have none), every other role nobody. The
 * caller blanks the text for users outside the set and keeps the rest of the
 * row, and logs the read with logPromptRead when the set is non-empty.
 */
export async function promptTextVisibleFor(
  session: AdminSessionResult,
  userIds: (string | null | undefined)[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (!session.authenticated || !canAccessAuditLog(session.role) || ids.length === 0) return new Set();
  if (lacksDepartment(session)) return new Set();
  const department = scopedDepartment(session as AuthedSession);
  const kept = await filterRowsToDepartment(ids.map(user_id => ({ user_id })), department);
  return new Set(kept.map(r => r.user_id));
}

/** Access-log a successful read of prompt text from one of those routes. */
export async function logPromptRead(request: NextRequest, session: AdminSessionResult, resource: string): Promise<void> {
  await logAccess({
    actorId: session.userId!, actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource, action: 'READ', outcome: 'success', detail: request.nextUrl.search || undefined,
  });
}

/**
 * Drops rows whose user is not in `department`. A null department returns the
 * rows unchanged. A row with no user, or a user with no department, is
 * dropped for a scoped caller (the events route's department filter excludes
 * those rows too).
 */
export async function filterRowsToDepartment<T extends { user_id?: string | null }>(
  rows: T[],
  department: string | null,
): Promise<T[]> {
  if (department === null || rows.length === 0) return rows;
  const ids = [...new Set(rows.map(r => r.user_id).filter((id): id is string => !!id))];
  if (ids.length === 0) return [];
  const client = await getTypedClient();
  const userRows = await client
    .select({ id: schema.users.id, department: schema.users.department })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  const adminRows = await client
    .select({ linked: schema.adminUsers.linked_cowork_user_id, department: schema.adminUsers.department })
    .from(schema.adminUsers)
    .where(inArray(schema.adminUsers.linked_cowork_user_id, ids));
  const deptOf = new Map<string, string | null>();
  for (const u of userRows) deptOf.set(u.id, u.department ?? null);
  // admin_users.department wins, as in COALESCE(au.department, u.department)
  for (const a of adminRows) if (a.linked && a.department) deptOf.set(a.linked, a.department);
  return rows.filter(r => !!r.user_id && deptOf.get(r.user_id) === department);
}


// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Who may see a person's Spend Review: admins and managers for anyone (the
// FinOps rule), and each person for their own (so the advice reads as help,
// not surveillance). "Own" is the linked account, else the same email — the
// rule Person 360 uses for person-level human time.
//
// This rule covers FinOps and Spend Review only. Code and Work Pulse show a
// person's spend under their own visibility rules (viewers organisation-wide,
// contributors their own department), and that is deliberate.
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { canAccessPulseAdmin, type AdminSessionResult } from '@/lib/auth/admin-auth';

export async function ownUserId(session: AdminSessionResult): Promise<string | null> {
  const client = await getTypedClient();
  const linked = session.userId
    ? await client.select({ id: schema.adminUsers.linked_cowork_user_id }).from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, session.userId)).limit(1)
    : [];
  if (linked[0]?.id) return linked[0].id;
  const byEmail = session.email
    ? await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, session.email)).limit(1)
    : [];
  return byEmail[0]?.id ?? null;
}

export async function canViewSpendReview(session: AdminSessionResult, userId: string): Promise<boolean> {
  if (!session.authenticated) return false;
  if (canAccessPulseAdmin(session.role)) return true;
  return (await ownUserId(session)) === userId;
}

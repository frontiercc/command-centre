// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The caller's person record (users.id) for S&C Board authorship. An entry
// stores its author as a users.id, but a session carries the admin_users id,
// which differs for admin-created and linked accounts, so a claim or submit
// recorded no author and the author never got the Edit button. Resolved the
// way Spend Review resolves "own": the linked account, else the same email,
// else a users row with the session's own id (auto-enrolled accounts share it).
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { AdminSessionResult } from '@/lib/auth/admin-auth';
import { ownUserId } from '@/lib/finance/spend-review-access';

export async function callerPersonId(session: AdminSessionResult): Promise<string | null> {
  if (!session.authenticated) return null;
  const own = await ownUserId(session);
  if (own) return own;
  if (!session.userId) return null;
  const client = await getTypedClient();
  const rows = await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
  return rows[0]?.id ?? null;
}

/** Whether the caller wrote this entry (matches the stored person id, or a legacy row that stored the session id). */
export async function isEntryAuthor(session: AdminSessionResult, authorUserId: string | null | undefined): Promise<boolean> {
  if (!authorUserId || !session.authenticated) return false;
  if (session.userId && authorUserId === session.userId) return true;
  return (await callerPersonId(session)) === authorUserId;
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Admin decisions on OTel identity conflicts. A conflict is
 * two Claude accounts sending from one installation; the resolver stores the
 * second email as its own person and records the clash here.
 *
 * Merge and undo are GOING FORWARD ONLY: a merge writes one
 * alias row so later events for that email go to the existing person; undo
 * deletes it. No history moves in either direction, which is what keeps undo a
 * one-row delete. A merge never touches logins (admin_users is untouched).
 */
import { desc, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';

export type ConflictStatus = 'open' | 'merged' | 'separate';
export type ConflictAction = 'merge' | 'separate' | 'undo';

export interface IdentityConflictRow {
  id: string;
  installationShort: string;
  surface: string;
  existingUserId: string;
  existingEmail: string | null;
  existingName: string | null;
  newEmail: string;
  newUserId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  status: ConflictStatus;
  decidedBy: string | null;
  decidedAt: number | null;
}

export async function listIdentityConflicts(): Promise<IdentityConflictRow[]> {
  const client = await getTypedClient();
  const c = schema.otelIdentityConflicts;
  const u = schema.users;
  const rows = await client
    .select({
      id: c.id, installation_id: c.installation_id, surface: c.surface,
      existing_user_id: c.existing_user_id, existing_email: u.email, existing_name: u.display_name,
      new_email: c.new_email, new_user_id: c.new_user_id,
      first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at, event_count: c.event_count,
      status: c.status, decided_by: c.decided_by, decided_at: c.decided_at,
    })
    .from(c)
    .leftJoin(u, eq(u.id, c.existing_user_id))
    .orderBy(desc(c.last_seen_at))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    installationShort: r.installation_id.slice(0, 8),
    surface: r.surface,
    existingUserId: r.existing_user_id,
    existingEmail: r.existing_email ?? null,
    existingName: r.existing_name ?? null,
    newEmail: r.new_email,
    newUserId: r.new_user_id,
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at),
    eventCount: Number(r.event_count),
    status: r.status as ConflictStatus,
    decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
  }));
}

export class ConflictStateError extends Error {}

/** Apply an admin decision. Throws ConflictStateError when the action does not fit the current status. */
export async function decideIdentityConflict(id: string, action: ConflictAction, actorEmail: string): Promise<ConflictStatus> {
  const client = await getTypedClient();
  const c = schema.otelIdentityConflicts;
  const nowS = Math.floor(Date.now() / 1000);

  return withTx(client, async (tx) => {
    const rows = await tx.select().from(c).where(eq(c.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new ConflictStateError('not_found');

    if (action === 'merge') {
      if (row.status !== 'open') throw new ConflictStateError(`cannot merge a conflict that is ${row.status}`);
      await tx.insert(schema.otelIdentityAliases).values({
        email: row.new_email,
        user_id: row.existing_user_id,
        conflict_id: row.id,
        created_by: actorEmail,
        created_at: nowS,
      }).onConflictDoUpdate({
        target: schema.otelIdentityAliases.email,
        set: { user_id: row.existing_user_id, conflict_id: row.id, created_by: actorEmail, created_at: nowS },
      });
      await tx.update(c).set({ status: 'merged', decided_by: actorEmail, decided_at: nowS }).where(eq(c.id, id));
      return 'merged';
    }

    if (action === 'separate') {
      if (row.status !== 'open') throw new ConflictStateError(`cannot keep separate a conflict that is ${row.status}`);
      await tx.update(c).set({ status: 'separate', decided_by: actorEmail, decided_at: nowS }).where(eq(c.id, id));
      return 'separate';
    }

    // undo
    if (row.status === 'open') throw new ConflictStateError('nothing to undo');
    if (row.status === 'merged') {
      await tx.delete(schema.otelIdentityAliases).where(eq(schema.otelIdentityAliases.conflict_id, row.id));
    }
    await tx.update(c).set({ status: 'open', decided_by: null, decided_at: null }).where(eq(c.id, id));
    return 'open';
  });
}

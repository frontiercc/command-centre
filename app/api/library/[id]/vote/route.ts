// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
//
// The vote TOGGLE (check existing -> delete-or-insert -> recount) is a
// genuine multi-statement atomic write, so it is wrapped in withTx
// -- otherwise two concurrent votes from the same user could interleave
// between the awaited statements and double-toggle. The user auto-upsert and
// entry-existence check stay outside the transaction (neither needs the
// toggle's atomicity guarantee).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { withTx } from '@/lib/db/with-tx';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession(_req);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: idStr } = await params;
  const client = await getTypedClient();
  const entryId = parseInt(idStr, 10);
  const userId = session.userId ?? '';
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const nowS = Math.floor(Date.now() / 1000);

  // Auto-upsert the user so the FK never blocks a vote from a valid session.
  // onConflictDoNothing() emits Postgres `ON CONFLICT DO NOTHING`.
  await client
    .insert(schema.users)
    .values({
      id: userId,
      display_name: userId.split('@')[0] ?? userId,
      email: userId,
      created_at: nowS,
    })
    .onConflictDoNothing();

  const entryRows = await client
    .select({ id: schema.skillLibraryEntries.id })
    .from(schema.skillLibraryEntries)
    .where(eq(schema.skillLibraryEntries.id, entryId));
  if (!entryRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const v = schema.skillLibraryVotes;

  const result = await withTx(client, async (tx) => {
    const existingRows = await tx
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.entry_id, entryId), eq(v.voter_user_id, userId)));
    const existing = existingRows[0];

    if (existing) {
      await tx.delete(v).where(and(eq(v.entry_id, entryId), eq(v.voter_user_id, userId)));
    } else {
      await tx.insert(v).values({ entry_id: entryId, voter_user_id: userId, voted_at: nowS });
    }

    const countRows = await tx
      .select({ cnt: sql<number | string>`COUNT(*)` })
      .from(v)
      .where(eq(v.entry_id, entryId));

    return { voted: !existing, count: Number(countRows[0]?.cnt ?? 0) };
  });

  return NextResponse.json(result);
}

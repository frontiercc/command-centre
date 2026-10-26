// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. Each
// user's statements are independent, autocommitted writes OUTSIDE any
// transaction, with no per-user try/catch: a DB error on one user propagates
// out of the loop (500), halting the batch while every prior user's insert
// stays committed. It is a plain, sequentially-awaited `for` loop with NO
// transaction wrapper by design: do not wrap this loop in a
// transaction/savepoint helper, which would change that behaviour.
// `onConflictDoNothing()` makes each insert idempotent; rowsAffected()
// (mirrors lib/db/queries.ts) gives the changed-row count that gates created vs skipped.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/** Affected-row count for UPDATE/DELETE/INSERT (mirrors lib/db/queries.ts's rowsAffected). */
function rowsAffected(result: unknown): number {
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { users } = await request.json() as {
    users: Array<{ email: string; display_name?: string; department?: string }>
  };

  if (!Array.isArray(users) || users.length === 0) {
    return NextResponse.json({ error: 'users array required' }, { status: 400 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  let created = 0, skipped = 0;

  for (const u of users) {
    if (!u.email) continue;
    const id = nanoid();
    const email = u.email.toLowerCase();

    const result = await client
      .insert(schema.users)
      .values({
        id, email, display_name: u.display_name ?? null, department: u.department ?? null,
        source: 'otel', first_seen_at: now, last_seen_at: null,
      })
      .onConflictDoNothing();

    if (rowsAffected(result) > 0) {
      // Resolve the actual user id (in case the insert was skipped due to an email conflict)
      const rows = await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
      const userId = rows[0]?.id ?? id;
      const adminRows = await client.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(eq(schema.adminUsers.email, email)).limit(1);
      if (!adminRows[0]) {
        await client.insert(schema.adminUsers).values({
          id: userId, email, password_hash: '__otel_pending__', display_name: u.display_name ?? null,
          role: 'cowork', department: u.department ?? null, linked_cowork_user_id: userId, sso_enabled: 0,
        });
      }
      created++;
    } else {
      skipped++;
    }
  }

  return NextResponse.json({ created, skipped });
}

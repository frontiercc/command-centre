// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder groupBy. COUNT(*) is Number()-coerced (bigint
// comes back as a STRING on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { isNotNull, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const u = schema.users;

  // Distinct team_ids with member count
  const rows = await client
    .select({ team_id: u.team_id, member_count: sql<number | string>`COUNT(*)` })
    .from(u)
    .where(isNotNull(u.team_id))
    .groupBy(u.team_id)
    .orderBy(u.team_id);

  const teams = rows.map(r => ({ team_id: r.team_id as string, member_count: Number(r.member_count) }));

  return NextResponse.json({ teams });
}

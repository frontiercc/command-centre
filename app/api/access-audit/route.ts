// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. This route
// reads the SEPARATE audit database (lib/db/audit-db.ts) via
// getAuditClient() + the audit schema (lib/db/schema-audit.ts) — NOT the main
// getClient()/schema. The actorEmail filter is a case-insensitive
// partial match, so it uses ILIKE (Postgres LIKE is case-sensitive).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, ilike, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAuditClient } from '@/lib/db/client';
import { auditSchema as schema, auditPgSchema } from '@/lib/db/schema-audit';
import { getAdminSession } from '@/lib/auth/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The access audit log records who read what — admin only.
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const actorEmail = params.get('actorEmail') || undefined;
  const resource   = params.get('resource')   || undefined;
  const action     = params.get('action')     || undefined;
  const dateFrom   = params.get('dateFrom')   ? parseInt(params.get('dateFrom')!) : undefined;
  const dateTo     = params.get('dateTo')     ? parseInt(params.get('dateTo')!)   : undefined;
  const format     = params.get('format'); // 'csv' for export

  // Typed facade (mirrors getTypedClient() in lib/db/client.ts):
  // getAuditClient()'s declared return type is the dialect UNION, whose two
  // members have structurally-incompatible builder signatures. There is no
  // shared getTypedAuditClient() helper (this is currently the only route
  // reading the audit DB directly), so the same narrow local cast is applied
  // here rather than widening the shared lib module for one call site.
  const client = (await getAuditClient()) as unknown as NodePgDatabase<typeof auditPgSchema>;
  const t = schema.accessAuditLog;
  const likeOp = ilike;

  const conditions = [];
  if (actorEmail) conditions.push(likeOp(t.actor_email, `%${actorEmail}%`));
  // A resource filter ending in '/*' selects a parameterised family (e.g.
  // 'config/*' for the per-key 'config/<key>' rows written by the secret
  // DELETE route) via a prefix LIKE rather than an exact match.
  if (resource) {
    if (resource.endsWith('/*')) {
      const prefix = resource.slice(0, -1); // drop the trailing '*', keep the '/'
      conditions.push(likeOp(t.resource, `${prefix}%`));
    } else {
      conditions.push(eq(t.resource, resource));
    }
  }
  if (action)     conditions.push(eq(t.action, action));
  if (dateFrom)   conditions.push(gte(t.occurred_at, dateFrom));
  if (dateTo)     conditions.push(lte(t.occurred_at, dateTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await client
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.occurred_at))
    .limit(500);

  if (format === 'csv') {
    const header = 'id,actor_id,actor_email,actor_ip,resource,action,outcome,detail,occurred_at\n';
    const csv = header + rows.map(r =>
      [
        r.id, r.actor_id, r.actor_email, r.actor_ip ?? '',
        r.resource, r.action, r.outcome,
        String(r.detail ?? '').replace(/,/g, ';'),
        r.occurred_at,
      ].join(',')
    ).join('\n');
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="access-audit.csv"',
      },
    });
  }

  return NextResponse.json(rows);
}

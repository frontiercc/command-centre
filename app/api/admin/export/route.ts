// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. The
// dynamic surface/date-range filters are a plain array of Drizzle conditions
// folded through `and()`, which avoids raw-SQL/bigint coercion (Drizzle's own
// bigint({mode:'number'}) column codec decodes occurred_at correctly).
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gte, lte, notInArray, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAdminSession } from '@/lib/auth/admin-auth';

export const dynamic = 'force-dynamic';

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCSV(cols: unknown[]): string {
  return cols.map(escapeCSV).join(',');
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const surface = params.get('surface') || 'all';
  const dateFrom = params.get('dateFrom') ? parseInt(params.get('dateFrom')!) : undefined;
  const dateTo   = params.get('dateTo')   ? parseInt(params.get('dateTo')!)   : undefined;

  const client = await getTypedClient();
  const lines: string[] = [];

  const header = ['Timestamp (UTC)', 'User', 'Department', 'Surface', 'Event Type', 'Content Preview'];
  lines.push(rowToCSV(header));

  // Cowork + Code messages
  if (surface === 'all' || surface === 'code' || surface === 'cowork') {
    const cm = schema.coworkMessages;
    const u = schema.users;
    const conditions: SQL[] = [
      notInArray(cm.message_type, ['cowork_tool_summary', 'cowork_message', 'cowork_session_init']),
    ];
    if (surface !== 'all') conditions.push(eq(cm.surface, surface));
    if (dateFrom) conditions.push(gte(cm.occurred_at, dateFrom));
    if (dateTo) conditions.push(lte(cm.occurred_at, dateTo));

    const rows = await client
      .select({
        occurred_at: cm.occurred_at,
        display_name: u.display_name,
        user_id: cm.user_id,
        department: u.department,
        surface: cm.surface,
        message_type: cm.message_type,
        content_preview: cm.content_preview,
      })
      .from(cm)
      .leftJoin(u, eq(cm.user_id, u.id))
      .where(and(...conditions))
      .orderBy(asc(cm.occurred_at));

    for (const r of rows) {
      const ts = new Date(r.occurred_at * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const user = r.display_name || (r.user_id ? r.user_id.split('@')[0] : '');
      lines.push(rowToCSV([ts, user, r.department ?? '', r.surface ?? '', r.message_type, r.content_preview ?? '']));
    }
  }

  // Chat messages
  if (surface === 'all' || surface === 'chat') {
    const chm = schema.chatMessages;
    const u = schema.users;
    const conditions: SQL[] = [];
    if (dateFrom) conditions.push(gte(chm.occurred_at, dateFrom));
    if (dateTo) conditions.push(lte(chm.occurred_at, dateTo));

    const rows = await client
      .select({
        occurred_at: chm.occurred_at,
        display_name: u.display_name,
        user_id: chm.user_id,
        department: u.department,
        prompt_text: chm.prompt_text,
      })
      .from(chm)
      .leftJoin(u, eq(chm.user_id, u.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(chm.occurred_at));

    for (const r of rows) {
      const ts = new Date(r.occurred_at * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const user = r.display_name || (r.user_id ? r.user_id.split('@')[0] : '');
      lines.push(rowToCSV([ts, user, r.department ?? '', 'chat', 'chat_prompt', r.prompt_text ?? '']));
    }
  }

  const csv = lines.join('\r\n');
  const filename = `ccc-audit-export-${new Date().toISOString().split('T')[0]}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

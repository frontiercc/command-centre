// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. The
// dynamic surface/date-range filters are a plain array of Drizzle conditions
// folded through `and()`, which avoids raw-SQL/bigint coercion (Drizzle's own
// bigint({mode:'number'}) column codec decodes occurred_at correctly).
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gte, isNull, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { productExpr } from '@/lib/dashboard/product-sql';
import { PRODUCTS, PRODUCT_IDS, type ProductId } from '@/lib/dashboard/vendor';

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

const productLabel = (id: string) => PRODUCTS.find(p => p.id === id)?.label ?? '';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  // `product` narrows to one product (Claude Cowork, ChatGPT Chat, Codex...);
  // `surface` is the older filter, kept for callers that still send it.
  const productParam = params.get('product');
  const product = productParam && (PRODUCT_IDS as string[]).includes(productParam) ? productParam as ProductId : null;
  const surface = product
    ? (product === 'claude_chat' ? 'chat' : product === 'claude_code' || product === 'codex' ? 'code' : 'cowork')
    : params.get('surface') || 'all';
  const dateFrom = params.get('dateFrom') ? parseInt(params.get('dateFrom')!) : undefined;
  const dateTo   = params.get('dateTo')   ? parseInt(params.get('dateTo')!)   : undefined;

  const client = await getTypedClient();
  const lines: string[] = [];

  const header = ['Timestamp (UTC)', 'User', 'Department', 'Surface', 'Product', 'Event Type', 'Content Preview'];
  lines.push(rowToCSV(header));

  // Cowork + Code messages
  if (surface === 'all' || surface === 'code' || surface === 'cowork') {
    const cm = schema.coworkMessages;
    const u = schema.users;
    const conditions: SQL[] = [
      notInArray(cm.message_type, ['cowork_tool_summary', 'cowork_message', 'cowork_session_init']),
    ];
    if (surface !== 'all') conditions.push(eq(cm.surface, surface));
    // Claude Chat prompts (surface 'chat') are exported in the Chat block below.
    else conditions.push(or(isNull(cm.surface), ne(cm.surface, 'chat'))!);
    if (product) conditions.push(sql`${sql.raw(productExpr('cowork_messages.'))} = ${product}`);
    if (dateFrom) conditions.push(gte(cm.occurred_at, dateFrom));
    if (dateTo) conditions.push(lte(cm.occurred_at, dateTo));

    const rows = await client
      .select({
        product: sql<string>`${sql.raw(productExpr('cowork_messages.'))}`,
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
      lines.push(rowToCSV([ts, user, r.department ?? '', r.surface ?? '', productLabel(r.product), r.message_type, r.content_preview ?? '']));
    }
  }

  // Chat messages
  if (surface === 'all' || surface === 'chat') {
    // Claude Chat prompts: cowork_messages, surface 'chat'.
    const chm = schema.coworkMessages;
    const u = schema.users;
    const conditions: SQL[] = [eq(chm.surface, 'chat'), eq(chm.message_type, 'cowork_user_message')];
    if (dateFrom) conditions.push(gte(chm.occurred_at, dateFrom));
    if (dateTo) conditions.push(lte(chm.occurred_at, dateTo));

    const rows = await client
      .select({
        occurred_at: chm.occurred_at,
        display_name: u.display_name,
        user_id: chm.user_id,
        department: u.department,
        prompt_text: sql<string | null>`coalesce(${chm.content_full}, ${chm.content_preview})`,
      })
      .from(chm)
      .leftJoin(u, eq(chm.user_id, u.id))
      .where(and(...conditions))
      .orderBy(asc(chm.occurred_at));

    for (const r of rows) {
      const ts = new Date(r.occurred_at * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const user = r.display_name || (r.user_id ? r.user_id.split('@')[0] : '');
      lines.push(rowToCSV([ts, user, r.department ?? '', 'chat', productLabel('claude_chat'), 'chat_prompt', r.prompt_text ?? '']));
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

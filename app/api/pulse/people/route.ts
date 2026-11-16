// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/pulse/people?list=admin-only|frontier-half&window=quarter|month&vendor=
 *
 * The people behind two of Work Pulse's headline figures, so their "See who" links show who:
 *  - admin-only: people who used Work Pulse's products in the window but handed over nothing
 *    judged meaningful or frontier ("N people only use it for administrative tasks");
 *  - frontier-half: the fewest people who together do half of the frontier work ("Frontier work
 *    rests on N people").
 * Rows are one per person per product (Claude or ChatGPT), counted as the cards count them
 * (personPerProduct), so the list's length is the card's figure. On All, frontier-half is each
 * product's own half, as the card is. The window is the card's (lib/pulse/org-window.ts).
 *
 * Access is the Users page's: any Work Pulse role; a contributor role sees its own department only.
 * Names and departments only, never prompt text.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getAdminSession, canAccessCoworkPulse, isDeptScoped } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { vendorClause, vendorExpr } from '@/lib/dashboard/product-sql';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { orgSummaryWindow } from '@/lib/pulse/org-window';
import { errorResponse } from '@/lib/api/errors';
import { getTierNames } from '@/lib/pulse/tier-config';

export const dynamic = 'force-dynamic';

export interface PersonRow {
  userId: string;
  name: string;
  department: string | null;
  product: 'claude' | 'openai';
  /** admin-only: graded tasks in the window (all administrative); frontier-half: frontier tasks. */
  tasks: number;
  /** frontier-half only: this person's share of their product's frontier work (or of all of it). */
  share: number | null;
}

type Row = { user_id: string; v: string; n: number | string; name: string | null; email: string | null; department: string | null };

async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  const client = await getTypedClient();
  const res = await (client as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(query);
  return res.rows as Row[];
}

/** The fewest of `list` (largest first) that together reach half of its total. */
function half<T extends { tasks: number }>(list: T[]): T[] {
  const total = list.reduce((a, r) => a + r.tasks, 0);
  const out: T[] = [];
  for (let acc = 0; out.length < list.length && acc < total / 2;) { acc += list[out.length].tasks; out.push(list[out.length]); }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession(request);
    if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canAccessCoworkPulse(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const deptOnly = isDeptScoped(session.role) ? session.department ?? null : null;
    if (isDeptScoped(session.role) && !deptOnly) {
      return NextResponse.json({ error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' }, { status: 422 });
    }

    const list = request.nextUrl.searchParams.get('list');
    if (list !== 'admin-only' && list !== 'frontier-half') return NextResponse.json({ error: 'Unknown list' }, { status: 400 });
    const quarterly = request.nextUrl.searchParams.get('window') === 'quarter';
    const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
    const now = Math.floor(Date.now() / 1000);
    const { start, end } = orgSummaryWindow(now, quarterly);
    const vend = sql.raw(vendorClause(vendor, 'cm.'));
    const prod = sql.raw(vendorExpr('cm.'));
    const person = sql`LEFT JOIN users u ON u.id = cm.user_id`;
    const dept = deptOnly ? sql`AND u.department = ${deptOnly}` : sql``;

    let people: PersonRow[];
    if (list === 'admin-only') {
      // Active on Work Pulse's products, as the card's activePeople30d, less anyone with graded
      // meaningful or frontier work, as its deepPeople30d; each counted once per product.
      const active = await rows(sql`
        SELECT cm.user_id, ${prod} AS v, COUNT(pc.id) FILTER (WHERE pc.classifier_status = 'classified') AS n,
               MAX(u.display_name) AS name, MAX(u.email) AS email, MAX(u.department) AS department
        FROM cowork_messages cm ${person}
        LEFT JOIN pulse_classifications pc ON pc.cowork_message_id = cm.id
        WHERE cm.user_id IS NOT NULL AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end}
          AND ${isWorkPulseSurface(sql`cm.surface`, true)} AND ${vend} ${dept}
        GROUP BY cm.user_id, 2`);
      const deep = new Set((await rows(sql`
        SELECT cm.user_id, ${prod} AS v, 0 AS n, NULL AS name, NULL AS email, NULL AS department
        FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id ${person}
        WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end}
          AND cm.user_id IS NOT NULL AND ${vend} ${dept}
        GROUP BY cm.user_id, 2`)).map(r => `${r.user_id}:${r.v}`));
      people = active
        .filter(r => !deep.has(`${r.user_id}:${r.v}`))
        .map(r => ({
          userId: r.user_id, name: r.name || r.email || r.user_id, department: r.department,
          product: r.v === 'openai' ? 'openai' as const : 'claude' as const, tasks: Number(r.n), share: null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      const frontier = (await rows(sql`
        SELECT cm.user_id, ${prod} AS v, COUNT(*) AS n,
               MAX(u.display_name) AS name, MAX(u.email) AS email, MAX(u.department) AS department
        FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id ${person}
        WHERE pc.classifier_status = 'classified' AND pc.tier = 3 AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end}
          AND cm.user_id IS NOT NULL AND ${vend} ${dept}
        GROUP BY cm.user_id, 2 ORDER BY 3 DESC`)).map(r => ({
          userId: r.user_id, name: r.name || r.email || r.user_id, department: r.department,
          product: r.v === 'openai' ? 'openai' as const : 'claude' as const, tasks: Number(r.n), share: null as number | null,
        }));
      // On All with both products, each product's own half, as the card counts it.
      const groups = vendor === 'all' && frontier.some(r => r.product === 'claude') && frontier.some(r => r.product === 'openai')
        ? [frontier.filter(r => r.product === 'claude'), frontier.filter(r => r.product === 'openai')]
        : [frontier];
      people = groups.flatMap(g => {
        const total = g.reduce((a, r) => a + r.tasks, 0);
        return half(g).map(r => ({ ...r, share: total > 0 ? r.tasks / total : null }));
      });
    }

    return NextResponse.json({ list, window: quarterly ? 'quarter' : 'month', vendor, start, end, people, departmentOnly: deptOnly, tierNames: await getTierNames() });
  } catch (err) {
    return errorResponse('api/pulse/people', err, { message: "Couldn't load the people behind this figure." });
  }
}

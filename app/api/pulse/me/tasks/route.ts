// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The work behind a figure on My Pulse: click "26 of 79 tasks" and see which tasks. With ?dept=
 * it is the work behind a figure on Departments: every member's, each row naming whose it is. A
 * department is read under the department page's own rule (app/api/pulse/dept/[dept]).
 *
 * Prompt text and AI summaries follow the same rule as everywhere else: a person always sees
 * their own, an admin sees anyone's, a manager sees their own department's, nobody else sees any
 * (lib/auth/content-access.ts), and a read of someone else's is logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCoworkPulse } from '@/lib/auth/admin-auth';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { PERIOD_SHAPE, type PulsePeriod } from '@/lib/pulse/period-shape';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const KINDS = ['realwork', 'tasks', 'capabilities', 'humantime'] as const;
type Kind = (typeof KINDS)[number];
const LIMIT = 60;

interface Exec { execute: (q: SQL) => Promise<{ rows: unknown[] }> }
const num = (v: unknown) => Number(v ?? 0);

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessCoworkPulse(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const p = request.nextUrl.searchParams;
  const period = (['week', 'month', 'quarter'] as const).includes(p.get('period') as PulsePeriod)
    ? (p.get('period') as PulsePeriod) : 'quarter';
  const kind = (KINDS.includes(p.get('kind') as Kind) ? p.get('kind') : 'realwork') as Kind;

  try {
    const client = await getTypedClient();
    const raw = client as unknown as Exec;

    const myId = async (): Promise<string | null> => {
      const linked = await client.select({ id: schema.adminUsers.linked_cowork_user_id })
        .from(schema.adminUsers).where(eq(schema.adminUsers.email, session.email!)).limit(1);
      if (linked[0]?.id) return linked[0].id;
      const byEmail = await client.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.email, session.email!)).limit(1);
      return byEmail[0]?.id ?? null;
    };

    const asked = p.get('userId');
    const askedDept = p.get('dept');
    const mine = await myId();
    // Whose work: one person, or every member of a department.
    let userIds: string[] = [];
    const names = new Map<string, string>();
    if (askedDept) {
      // The department page's rule: a department-scoped role reads only its own department.
      if (isDeptScoped(session.role) && askedDept !== session.department) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const members = await client.select({ id: schema.users.id, name: schema.users.display_name, email: schema.users.email })
        .from(schema.users).where(eq(schema.users.department, askedDept));
      userIds = members.map(m => m.id);
      for (const m of members) names.set(m.id, m.name ?? m.email ?? m.id);
      const shown = userIds.length === 0 ? [] : await client.select({ id: schema.adminUsers.linked_cowork_user_id, name: schema.adminUsers.display_name })
        .from(schema.adminUsers).where(inArray(schema.adminUsers.linked_cowork_user_id, userIds));
      for (const a of shown) if (a.id && a.name) names.set(a.id, a.name);
    } else {
      let userId: string | null = mine;
      if (asked && asked !== mine) {
        if (session.role === 'admin' || session.role === 'manager') userId = asked;
        else if (isDeptScoped(session.role) && session.department) {
          const target = await client.select({ department: schema.adminUsers.department })
            .from(schema.adminUsers).where(eq(schema.adminUsers.linked_cowork_user_id, asked)).limit(1);
          if (target[0]?.department !== session.department) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          userId = asked;
        } else return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (userId) userIds = [userId];
    }
    if (userIds.length === 0) return NextResponse.json({ items: [], textVisible: false });

    // Prompt text and AI summaries: own always, otherwise the Audit Log rule, and logged.
    const visibleIds = await promptTextVisibleFor(session, userIds.filter(id => id !== mine));
    if (mine && userIds.includes(mine)) visibleIds.add(mine);
    const textVisible = userIds.some(id => visibleIds.has(id));
    if ([...visibleIds].some(id => id !== mine && userIds.includes(id))) await logPromptRead(request, session, 'pulse/me/tasks');
    const who = sql.join(userIds.map(id => sql`${id}`), sql`, `);
    const nameOf = (id: string) => (askedDept ? names.get(id) ?? null : null);

    const vendor = await visibleVendor(p.get('vendor'));
    const { buckets, bucketSecs } = PERIOD_SHAPE[period];
    const end = Math.floor(Date.now() / 1000);
    const start = end - buckets * bucketSecs;
    const msgVendor = sql.raw(vendorClause(vendor, 'cm.'));

    if (kind === 'capabilities') {
      const rows = (await raw.execute(sql`
        SELECT user_id, title, status, detected_at, confirmed_at FROM pulse_events
        WHERE user_id IN (${who}) AND event_type = 'capability_creation'
          AND (status = 'candidate' OR (confirmed_at >= ${start} AND confirmed_at < ${end}))
        ORDER BY COALESCE(confirmed_at, detected_at) DESC LIMIT ${LIMIT}
      `)).rows as Array<{ user_id: string; title: string; status: string; detected_at: number | string; confirmed_at: number | string | null }>;
      return NextResponse.json({
        items: rows.map(r => ({
          at: num(r.confirmed_at ?? r.detected_at), title: r.title, status: r.status, name: nameOf(r.user_id),
        })),
        textVisible,
      });
    }

    if (kind === 'humantime') {
      // The same sessions as the panel's totals (lib/pulse/my-period.ts): Claude Cowork and Claude
      // in Office/Google from their session stats, ChatGPT from its conversation time.
      const parts: SQL[] = [];
      if (vendor !== 'openai') parts.push(sql`
        SELECT s.session_id, s.user_id, s.first_event_at AS at, s.human_minutes_likely AS likely, s.active_secs AS secs
        FROM cowork_session_stats s
        WHERE s.user_id IN (${who}) AND s.first_event_at >= ${start} AND s.first_event_at < ${end}
          AND s.human_minutes_likely IS NOT NULL AND s.active_secs > 0`);
      if (vendor !== 'claude') parts.push(sql`
        SELECT g.session_id, g.user_id, g.first_at AS at, g.human_minutes_likely AS likely, g.active_secs AS secs
        FROM chatgpt_session_time g
        WHERE g.user_id IN (${who}) AND g.first_at >= ${start} AND g.first_at < ${end}
          AND g.human_minutes_likely IS NOT NULL AND g.active_secs > 0`);
      const rows = parts.length === 0 ? [] : (await raw.execute(sql`
        SELECT x.session_id, x.user_id, x.at, x.likely, x.secs,
               d.description AS description,
               (SELECT STRING_AGG(DISTINCT cm.output_name, ', ') FROM cowork_messages cm
                 WHERE cm.session_id = x.session_id AND cm.output_name IS NOT NULL) AS outputs
        FROM (${sql.join(parts, sql` UNION ALL `)}) x
        LEFT JOIN cowork_session_descriptions d ON d.session_id = x.session_id
        ORDER BY x.likely DESC LIMIT ${LIMIT}
      `)).rows as Array<{ session_id: string; user_id: string; at: number | string; likely: number | string; secs: number | string; description: string | null; outputs: string | null }>;
      return NextResponse.json({
        items: rows.map(r => ({
          sessionId: r.session_id, at: num(r.at), name: nameOf(r.user_id),
          humanMinutes: num(r.likely), claudeMinutes: num(r.secs) / 60,
          description: visibleIds.has(r.user_id) ? r.description : null,
          outputs: visibleIds.has(r.user_id) ? r.outputs : null,
        })),
        textVisible,
      });
    }

    const onlyReal = kind === 'realwork' ? sql`AND pc.tier >= 2` : sql``;
    const rows = (await raw.execute(sql`
      SELECT cm.session_id, pc.user_id, cm.occurred_at AS at, pc.tier, pc.task_type,
             COALESCE(cm.content_full, cm.content_preview) AS text,
             d.description AS description,
             (SELECT STRING_AGG(DISTINCT o.output_name, ', ') FROM cowork_messages o
               WHERE o.session_id = cm.session_id AND o.output_name IS NOT NULL) AS outputs
      FROM pulse_classifications pc
      JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      LEFT JOIN cowork_session_descriptions d ON d.session_id = cm.session_id
      WHERE pc.user_id IN (${who}) AND pc.classifier_status = 'classified' ${onlyReal}
        AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}
      ORDER BY cm.occurred_at DESC LIMIT ${LIMIT}
    `)).rows as Array<{ session_id: string; user_id: string; at: number | string; tier: number | string; task_type: string; text: string | null; description: string | null; outputs: string | null }>;

    return NextResponse.json({
      items: rows.map(r => ({
        sessionId: r.session_id, at: num(r.at), tier: num(r.tier), taskType: r.task_type, name: nameOf(r.user_id),
        text: visibleIds.has(r.user_id) ? (r.text ?? null) : null,
        description: visibleIds.has(r.user_id) ? r.description : null,
        outputs: visibleIds.has(r.user_id) ? r.outputs : null,
      })),
      textVisible,
    });
  } catch (err) {
    return errorResponse('pulse/me/tasks', err);
  }
}

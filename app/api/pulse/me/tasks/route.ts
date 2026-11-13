// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The work behind a figure on My Pulse: click "26 of 79 tasks" and see which tasks.
 *
 * Prompt text and AI summaries follow the same rule as everywhere else: a person always sees
 * their own, an admin sees anyone's, a manager sees their own department's, nobody else sees any
 * (lib/auth/content-access.ts), and a read of someone else's is logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, sql, type SQL } from 'drizzle-orm';
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
    const mine = await myId();
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
    if (!userId) return NextResponse.json({ items: [], textVisible: false });

    // Prompt text and AI summaries: own always, otherwise the Audit Log rule, and logged.
    const isSelf = userId === mine;
    const textVisible = isSelf || (await promptTextVisibleFor(session, [userId])).has(userId);
    if (textVisible && !isSelf) await logPromptRead(request, session, 'pulse/me/tasks');

    const vendor = await visibleVendor(p.get('vendor'));
    const { buckets, bucketSecs } = PERIOD_SHAPE[period];
    const end = Math.floor(Date.now() / 1000);
    const start = end - buckets * bucketSecs;
    const msgVendor = sql.raw(vendorClause(vendor, 'cm.'));

    if (kind === 'capabilities') {
      const rows = (await raw.execute(sql`
        SELECT title, status, detected_at, confirmed_at FROM pulse_events
        WHERE user_id = ${userId} AND event_type = 'capability_creation'
          AND (status = 'candidate' OR (confirmed_at >= ${start} AND confirmed_at < ${end}))
        ORDER BY COALESCE(confirmed_at, detected_at) DESC LIMIT ${LIMIT}
      `)).rows as Array<{ title: string; status: string; detected_at: number | string; confirmed_at: number | string | null }>;
      return NextResponse.json({
        items: rows.map(r => ({
          at: num(r.confirmed_at ?? r.detected_at), title: r.title, status: r.status,
        })),
        textVisible,
      });
    }

    if (kind === 'humantime') {
      const rows = (await raw.execute(sql`
        SELECT s.session_id, s.first_event_at AS at, s.human_minutes_likely AS likely, s.active_secs AS secs,
               d.description AS description,
               (SELECT STRING_AGG(DISTINCT cm.output_name, ', ') FROM cowork_messages cm
                 WHERE cm.session_id = s.session_id AND cm.output_name IS NOT NULL) AS outputs
        FROM cowork_session_stats s
        LEFT JOIN cowork_session_descriptions d ON d.session_id = s.session_id
        WHERE s.user_id = ${userId} AND s.first_event_at >= ${start} AND s.first_event_at < ${end}
          AND s.human_minutes_likely IS NOT NULL AND s.active_secs > 0
        ORDER BY s.human_minutes_likely DESC LIMIT ${LIMIT}
      `)).rows as Array<{ session_id: string; at: number | string; likely: number | string; secs: number | string; description: string | null; outputs: string | null }>;
      return NextResponse.json({
        items: rows.map(r => ({
          sessionId: r.session_id, at: num(r.at),
          humanMinutes: num(r.likely), claudeMinutes: num(r.secs) / 60,
          description: textVisible ? r.description : null,
          outputs: textVisible ? r.outputs : null,
        })),
        textVisible,
      });
    }

    const onlyReal = kind === 'realwork' ? sql`AND pc.tier >= 2` : sql``;
    const rows = (await raw.execute(sql`
      SELECT cm.session_id, cm.occurred_at AS at, pc.tier, pc.task_type,
             COALESCE(cm.content_full, cm.content_preview) AS text,
             d.description AS description,
             (SELECT STRING_AGG(DISTINCT o.output_name, ', ') FROM cowork_messages o
               WHERE o.session_id = cm.session_id AND o.output_name IS NOT NULL) AS outputs
      FROM pulse_classifications pc
      JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
      LEFT JOIN cowork_session_descriptions d ON d.session_id = cm.session_id
      WHERE pc.user_id = ${userId} AND pc.classifier_status = 'classified' ${onlyReal}
        AND cm.occurred_at >= ${start} AND cm.occurred_at < ${end} AND ${msgVendor}
      ORDER BY cm.occurred_at DESC LIMIT ${LIMIT}
    `)).rows as Array<{ session_id: string; at: number | string; tier: number | string; task_type: string; text: string | null; description: string | null; outputs: string | null }>;

    return NextResponse.json({
      items: rows.map(r => ({
        sessionId: r.session_id, at: num(r.at), tier: num(r.tier), taskType: r.task_type,
        text: textVisible ? (r.text ?? null) : null,
        description: textVisible ? r.description : null,
        outputs: textVisible ? r.outputs : null,
      })),
      textVisible,
    });
  } catch (err) {
    return errorResponse('pulse/me/tasks', err);
  }
}

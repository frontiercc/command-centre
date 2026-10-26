// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects/joins, and a local rawAll()/rawGet() facade for the NOT-IN-
// subquery pending-count read (mirrors lib/pulse/classifier.ts). The COUNT
// aggregate is Number()-coerced (Postgres returns bigint and numeric as strings).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

// ─── Raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────────────
interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}
async function rawGet<T>(client: unknown, query: unknown): Promise<T | undefined> {
  const rows = await rawAll<T>(client, query);
  return rows[0];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { userId } = await params;
  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const userRows = await client
    .select({
      id: schema.users.id,
      display_name: schema.users.display_name,
      email: schema.users.email,
      department: schema.users.department,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const user = userRows[0];
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const prefsRows = await client
    .select({ pulse_start_at: schema.pulseUserPrefs.pulse_start_at })
    .from(schema.pulseUserPrefs)
    .where(eq(schema.pulseUserPrefs.user_id, userId))
    .limit(1);
  const pulseStartAt = prefsRows[0]?.pulse_start_at ?? null;

  const classificationRows = await client
    .select({
      id: pc.id,
      tier: pc.tier,
      task_type: pc.task_type,
      classifier_confidence: pc.classifier_confidence,
      classifier_model: pc.classifier_model,
      classifier_status: pc.classifier_status,
      classifier_error: pc.classifier_error,
      classified_at: pc.classified_at,
      frontier_push_candidate: pc.frontier_push_candidate,
      capability_creation_candidate: pc.capability_creation_candidate,
      content_preview: cm.content_preview,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(pulseStartAt
      ? and(eq(pc.user_id, userId), gte(pc.classified_at, pulseStartAt))
      : eq(pc.user_id, userId))
    .orderBy(desc(pc.classified_at))
    .limit(100);

  // content_preview is the first 250 characters of each prompt: same rule as
  // the Audit Log, so a manager sees it only for people in their own
  // department (everyone when they have none). The tiers and labels stay.
  const seesPrompt = classificationRows.length > 0
    && (await promptTextVisibleFor(session, [userId])).has(userId);
  if (seesPrompt) await logPromptRead(request, session, 'pulse/admin/user-detail');
  const classifications = seesPrompt
    ? classificationRows
    : classificationRows.map(c => ({ ...c, content_preview: null }));

  const briefings = await client
    .select({
      body: schema.pulseBriefings.body,
      suggestion: schema.pulseBriefings.suggestion,
      generated_at: schema.pulseBriefings.generated_at,
    })
    .from(schema.pulseBriefings)
    .where(and(eq(schema.pulseBriefings.scope_id, userId), eq(schema.pulseBriefings.scope_type, 'user')))
    .orderBy(desc(schema.pulseBriefings.generated_at));

  const pendingCountRow = await rawGet<{ cnt: number | string }>(client, sql`
     SELECT COUNT(*) as cnt FROM cowork_messages
     WHERE user_id = ${userId} AND surface = 'cowork'
       AND message_type = 'cowork_user_message'
       AND id NOT IN (
         SELECT cowork_message_id FROM pulse_classifications
         WHERE classifier_status = 'classified' OR classifier_attempts >= 5
       )
  `);
  const pendingCount = Number(pendingCountRow?.cnt ?? 0);

  return NextResponse.json({
    user,
    classifications,
    briefings,
    pendingCount,
    pulseStartAt,
  });
}

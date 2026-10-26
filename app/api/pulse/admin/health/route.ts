// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects/joins, and a local rawAll()/rawGet() facade for the NOT-IN-
// subquery / GROUP BY analytic reads (mirrors lib/pulse/classifier.ts + app/
// api/pulse/me/route.ts). Every raw-SQL COUNT/MIN/MAX aggregate is Number()-
// coerced (bigint/numeric come back as STRINGS on Postgres). The
// day-bucket GROUP BY (tierDist) groups by the SELECT output alias `day`,
// as app/api/pulse/cio/route.ts does for its month bucket.
// PostgreSQL permits grouping by an output-column alias as an extension.
import { STRIPPED_MARKER } from '@/lib/retention/cleanup';
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
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

/** Affected-row count for UPDATE/DELETE (mirrors lib/db/queries.ts's rowsAffected). */
function rowsAffected(result: unknown): number {
  const r = result as { rowCount?: number | null };
  return r.rowCount ?? 0;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  // Match the classifier's candidate set: it only classifies user messages
  // (runClassifierJob filters message_type = 'cowork_user_message'). Counting
  // every cowork message here would leave tool/api rows permanently "queued".
  const queueDepthRow = await rawGet<{ cnt: number | string }>(client, sql`
     SELECT COUNT(*) as cnt FROM cowork_messages
     WHERE surface = 'cowork'
       AND message_type = 'cowork_user_message'
       AND COALESCE(content_full, content_preview, '') <> ${STRIPPED_MARKER}
       AND id NOT IN (
         SELECT cowork_message_id FROM pulse_classifications
         WHERE classifier_status = 'classified' OR classifier_attempts >= 5
       )
  `);
  const queueDepth = Number(queueDepthRow?.cnt ?? 0);

  const dayExpr = sql`to_char(to_timestamp(classified_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const tierDistRaw = await rawAll<{ day: string; tier: number; cnt: number | string }>(client, sql`
     SELECT
       ${dayExpr} AS day,
       tier,
       COUNT(*) AS cnt
     FROM pulse_classifications
     WHERE classifier_status = 'classified'
       AND classified_at >= ${thirtyDaysAgo}
     GROUP BY day, tier
     ORDER BY day ASC
  `);
  const tierDist = tierDistRaw.map(r => ({ day: r.day, tier: r.tier, cnt: Number(r.cnt) }));

  const confidenceHistRaw = await rawAll<{ bucket: number; cnt: number | string }>(client, sql`
     SELECT
       CAST(ROUND(classifier_confidence * 10) AS INTEGER) AS bucket,
       COUNT(*) AS cnt
     FROM pulse_classifications
     WHERE classifier_status = 'classified'
     GROUP BY bucket
     ORDER BY bucket ASC
  `);
  const confidenceHist = confidenceHistRaw.map(r => ({ bucket: r.bucket, cnt: Number(r.cnt) }));

  const failures = await client
    .select({
      id: pc.id,
      classifier_error: pc.classifier_error,
      classifier_attempts: pc.classifier_attempts,
      classified_at: pc.classified_at,
      classifier_model: pc.classifier_model,
      content_preview: cm.content_preview,
      user_id: cm.user_id,
      display_name: schema.users.display_name,
      email: schema.users.email,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .leftJoin(schema.users, eq(schema.users.id, cm.user_id))
    .where(eq(pc.classifier_status, 'failed'))
    .orderBy(desc(pc.classified_at))
    .limit(50);

  const modelLogRaw = await rawAll<{
    classifier_model: string; first_used: number | string;
    last_used: number | string; total_classified: number | string;
  }>(client, sql`
     SELECT
       classifier_model,
       MIN(classified_at) AS first_used,
       MAX(classified_at) AS last_used,
       COUNT(*) AS total_classified
     FROM pulse_classifications
     GROUP BY classifier_model
     ORDER BY first_used DESC
  `);
  const modelLog = modelLogRaw.map(r => ({
    classifier_model: r.classifier_model,
    first_used: Number(r.first_used),
    last_used: Number(r.last_used),
    total_classified: Number(r.total_classified),
  }));

  return NextResponse.json({ queueDepth, tierDist, confidenceHist, failures, modelLog });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const pc = schema.pulseClassifications;

  const result = await client.delete(pc).where(eq(pc.classifier_status, 'failed'));

  return NextResponse.json({ ok: true, retried: rowsAffected(result) });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + a local rawGet()
// facade for the NOT-IN-subquery queue-depth read (mirrors lib/pulse/
// classifier.ts's own candidate-set query + app/api/pulse/admin/health/
// route.ts). The COUNT aggregate is Number()-coerced (Postgres returns bigint and numeric as strings).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { runClassifierJob } from '@/lib/pulse/classifier';
import { drainJob } from '@/lib/pulse/drain';
import { getConfigValue } from '@/lib/config';

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

async function getQueueDepth(): Promise<number> {
  const client = await getTypedClient();
  // Match runClassifierJob's candidate set (message_type = 'cowork_user_message').
  // Counting all cowork messages left non-user rows permanently "queued".
  const row = await rawGet<{ cnt: number | string }>(client, sql`
     SELECT COUNT(*) as cnt FROM cowork_messages
     WHERE surface = 'cowork'
       AND message_type = 'cowork_user_message'
       AND id NOT IN (
         SELECT cowork_message_id FROM pulse_classifications
         WHERE classifier_status = 'classified' OR classifier_attempts >= 5
       )
  `);
  return Number(row?.cnt ?? 0);
}

// POST /api/pulse/admin/classify — run classifier batches immediately (up to 20 batches of 25 messages)
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const pulseEnabled = (await getConfigValue('pulseEnabled')) === 'true';
  if (!pulseEnabled) {
    return NextResponse.json({ error: 'Pulse is not enabled' }, { status: 400 });
  }

  const before = await getQueueDepth();
  if (before === 0) {
    return NextResponse.json({ ok: true, classified: 0, remaining: 0, message: 'Nothing to classify.' });
  }

  // drainJob's own classified count (not a queue-depth delta): a batch
  // whose rows merely exhaust their attempts without succeeding shrinks the
  // queue but must not be reported as "classified", so the count comes from
  // the job's own per-row result.
  const result = await drainJob(runClassifierJob, { maxPasses: 20 });
  const after = await getQueueDepth();

  return NextResponse.json({
    ok: true,
    classified: result.classified,
    remaining: after,
    message: result.classified === 0
      ? `Nothing classified this run (${result.failed} failed). ${after} still queued.`
      : after === 0
        ? `All ${result.classified} message(s) classified.`
        : `Classified ${result.classified} message(s). ${after} still queued. The scheduler will continue.`,
  });
}

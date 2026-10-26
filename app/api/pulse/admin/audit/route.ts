// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Classifier accuracy audit (§2). Admin-only. GET returns the published
// rolling-quarter figure, the current open cycle's UN-reviewed items (blind —
// the classifier's tier is never sent to the client), and scored history.
// POST drives the workflow: draw a cycle, submit a blind review, or score.
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { drawAuditSample, recordReview, scoreAuditCycle, getPublishedAgreement } from '@/lib/pulse/audit/cycle';

export const dynamic = 'force-dynamic';

const SURFACE = 'cowork';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const c = schema.pulseAuditCycles;

  const published = await getPublishedAgreement(SURFACE);

  const openRows = await client
    .select({ id: c.id, period: c.period, n_sampled: c.n_sampled, n_reviewed: c.n_reviewed })
    .from(c)
    .where(and(eq(c.surface, SURFACE), eq(c.status, 'open')))
    .orderBy(desc(c.created_at))
    .limit(1);
  const open = openRows[0] ?? null;

  let items: Array<{ id: number; content: string | null; taskType: string | null }> = [];
  if (open) {
    const rows = await client
      .select({
        id: schema.pulseAuditItems.id,
        content: schema.coworkMessages.content_preview,
        taskType: schema.pulseClassifications.task_type,
      })
      .from(schema.pulseAuditItems)
      .innerJoin(schema.pulseClassifications, eq(schema.pulseClassifications.id, schema.pulseAuditItems.classification_id))
      .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
      .where(and(eq(schema.pulseAuditItems.cycle_id, Number(open.id)), isNull(schema.pulseAuditItems.human_tier)));
    items = rows.map(r => ({ id: Number(r.id), content: r.content, taskType: r.taskType }));
  }

  const history = (await client
    .select({ id: c.id, period: c.period, agreement_pct: c.agreement_pct, kappa: c.kappa, n_reviewed: c.n_reviewed, scored_at: c.scored_at })
    .from(c)
    .where(and(eq(c.surface, SURFACE), eq(c.status, 'scored')))
    .orderBy(desc(c.scored_at))
    .limit(12))
    .map(r => ({ id: Number(r.id), period: r.period, agreementPct: r.agreement_pct === null ? null : Number(r.agreement_pct), kappa: r.kappa === null ? null : Number(r.kappa), nReviewed: Number(r.n_reviewed) }));

  return NextResponse.json({
    published,
    open: open ? { id: Number(open.id), period: open.period, nSampled: Number(open.n_sampled), nReviewed: Number(open.n_reviewed), items } : null,
    history,
    kappaFloor: 0.6,
  });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action as string | undefined;

  try {
    if (action === 'draw') {
      const period = typeof body.period === 'string' && /^\d{4}-\d{2}$/.test(body.period) ? body.period : null;
      if (!period) return NextResponse.json({ error: 'period must be YYYY-MM' }, { status: 400 });
      // Deterministic seed derived from the period (stable, reproducible; no RNG at call time).
      const seed = Number(period.replace('-', ''));
      const result = await drawAuditSample({ period, surface: SURFACE, seed, size: 50 });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'review') {
      const itemId = Number(body.itemId);
      const humanTier = Number(body.humanTier);
      if (!Number.isInteger(itemId) || ![1, 2, 3].includes(humanTier)) {
        return NextResponse.json({ error: 'itemId and humanTier (1|2|3) required' }, { status: 400 });
      }
      await recordReview(itemId, humanTier, typeof body.humanTaskType === 'string' ? body.humanTaskType : null, session.email!);
      return NextResponse.json({ ok: true });
    }

    if (action === 'score') {
      const cycleId = Number(body.cycleId);
      if (!Number.isInteger(cycleId)) return NextResponse.json({ error: 'cycleId required' }, { status: 400 });
      const scored = await scoreAuditCycle(cycleId);
      if (!scored) return NextResponse.json({ error: 'Nothing reviewed yet' }, { status: 400 });
      return NextResponse.json({ ok: true, ...scored });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return errorResponse('api/pulse/admin/audit', err);
  }
}

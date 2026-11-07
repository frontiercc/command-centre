// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { openaiShown } from '@/lib/sources/openai-visibility';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildChargeback, type ChargebackReport } from '@/lib/finance/chargeback';
import { currentPeriod, monthBounds } from '@/lib/finance/period';
import { officeSpendByUser, summariseOfficeSpend } from '@/lib/finance/office-spend';
import { buildFinopsProjection } from '@/lib/finance/finops-projection';
import { buildInsightFacts, composeInsightNarrative, type InsightFacts } from '@/lib/finance/insights';
import { getSeatsSummary, getChatgptSeatsSummary } from '@/lib/finance/seats';

export const dynamic = 'force-dynamic';

/** Prior calendar month for a 'YYYY-MM' period string (UTC). */
function priorPeriodOf(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1)); // m is 1-indexed; m-2 = previous month, 0-indexed
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function GET(request: NextRequest) {
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const period = request.nextUrl.searchParams.get('period') || currentPeriod(Math.floor(Date.now() / 1000));
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });
  }
  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/chargeback',
    action: 'READ',
    outcome: 'success',
  });

  const nowS = Math.floor(Date.now() / 1000);
  const current = await buildChargeback(period, nowS);
  const projection = buildFinopsProjection(current.grandTotalUsd, current.monthToDate, nowS);

  // Insight is fully deterministic — computed facts + a templated prose summary,
  // NO LLM call (keeps the page fast; no synchronous Claude round-trip). Best-effort:
  // a failure (e.g. bad prior period) must never 500 the whole report.
  let insight: { facts: InsightFacts; narrative: string | null };
  try {
    let prior: ChargebackReport | null = null;
    try {
      prior = await buildChargeback(priorPeriodOf(period), nowS);
    } catch {
      prior = null;
    }
    const facts = buildInsightFacts(current, prior, projection);
    insight = { facts, narrative: composeInsightNarrative(facts) };
  } catch {
    insight = { facts: buildInsightFacts(current, null, null), narrative: null };
  }

  // Additive, never-throwing: a seats-computation failure must never break
  // the chargeback report. Never touches grandTotalUsd/buildChargeback/close
  // snapshots — computed here, not in lib/finance/chargeback.ts.
  const seats = await getSeatsSummary(nowS).catch(() => null);
  // The ChatGPT licence: OpenAI charges it per seat, apart from usage, so it
  // sits beside the usage figures and is never added to grandTotalUsd.
  const chatgptSeats = (await openaiShown()) ? await getChatgptSeatsSummary(nowS).catch(() => null) : null;

  // Claude in Office: an estimate from tokens (Office sends no cost), shown
  // beside the surfaces and never part of grandTotalUsd, a cost centre, a
  // closed-period snapshot or the CSV. Computed here, like seats. Additive,
  // never-throwing; every app listed (at zero before Office activity arrives),
  // so the panel always shows.
  const { start, end } = monthBounds(period);
  // Admin → Work Pulse "Show Claude in Office" off hides the panel.
  const officeShown = (await getAllConfig()).claudeInOfficeShown !== 'false';
  const office = officeShown
    ? await officeSpendByUser(start, end).then(rows => summariseOfficeSpend(rows, { allApps: true })).catch(() => null)
    : null;

  return NextResponse.json({ ...current, projection, insight, seats, chatgptSeats, office });
}

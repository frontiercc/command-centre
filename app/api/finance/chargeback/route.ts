// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { openaiShown } from '@/lib/sources/openai-visibility';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildChargeback, type ChargebackReport, type ChargebackShared } from '@/lib/finance/chargeback';
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
  const config = await getAllConfig();
  if (config.chargebackEnabled !== true) {
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

  const nowS = Math.floor(Date.now() / 1000);

  // --- Stage 1: the access record, this month's report and last month's, together ---
  // Both months share one set of lookups (rates, people, cost centres), read once.
  // Last month only feeds the insight and is best-effort: a failure there
  // (e.g. a bad prior period) must never 500 the whole report.
  const shared: ChargebackShared = {};
  const [, current, prior] = await Promise.all([
    logAccess({
      actorId: session.userId!,
      actorEmail: session.email!,
      actorIp: request.headers.get('x-forwarded-for') || undefined,
      resource: 'finance/chargeback',
      action: 'READ',
      outcome: 'success',
    }),
    buildChargeback(period, nowS, shared),
    (async (): Promise<ChargebackReport | null> => buildChargeback(priorPeriodOf(period), nowS, shared))().catch(() => null),
  ]);

  const projection = buildFinopsProjection(current.grandTotalUsd, current.monthToDate, nowS);
  // Claude's and OpenAI's month-end figures, each projected from its own
  // month-to-date spend by the same run rate (so they add up to `projection`).
  // Only with the Claude / OpenAI split, i.e. ChatGPT and Codex connected and shown.
  const projectionByVendor = projection && current.vendors
    ? {
        claudeUsd: buildFinopsProjection(current.vendors.claudeUsd, current.monthToDate, nowS)!.projected,
        openaiUsd: buildFinopsProjection(current.vendors.openaiUsd, current.monthToDate, nowS)!.projected,
      }
    : null;

  // Insight is fully deterministic — computed facts + a templated prose summary,
  // NO LLM call (keeps the page fast; no synchronous Claude round-trip). Best-effort.
  let insight: { facts: InsightFacts; narrative: string | null };
  try {
    const facts = buildInsightFacts(current, prior, projection);
    insight = { facts, narrative: composeInsightNarrative(facts) };
  } catch {
    insight = { facts: buildInsightFacts(current, null, null), narrative: null };
  }

  // --- Stage 2: the side panels, together ---
  // Additive, never-throwing: a seats-computation failure must never break
  // the chargeback report. Never touches grandTotalUsd/buildChargeback/close
  // snapshots — computed here, not in lib/finance/chargeback.ts.
  // Parts that failed to build: their panels say they couldn't load, never vanish.
  //
  // The ChatGPT licence: OpenAI charges it per seat, apart from usage, so it
  // sits beside the usage figures and is never added to grandTotalUsd.
  //
  // Claude in Office: an estimate from tokens (Office sends no cost), shown
  // beside the surfaces and never part of grandTotalUsd, a cost centre, a
  // closed-period snapshot or the CSV. Computed here, like seats. Additive,
  // never-throwing; every app listed (at zero before Office activity arrives),
  // so the panel always shows. Admin → Work Pulse "Show Claude in Office" off hides the panel.
  const { start, end } = monthBounds(period);
  const officeShown = config.claudeInOfficeShown !== 'false';
  const FAILED = Symbol('failed');
  const [seatsResult, chatgptSeatsResult, officeResult] = await Promise.all([
    getSeatsSummary(nowS).catch(() => FAILED),
    openaiShown().then(shown => (shown ? getChatgptSeatsSummary(nowS).catch(() => FAILED) : null)),
    officeShown
      ? officeSpendByUser(start, end).then(rows => summariseOfficeSpend(rows, { allApps: true })).catch(() => FAILED)
      : null,
  ]);
  // Listed in the same order as the panels: seats, the ChatGPT licence (also 'seats'), Office.
  const failed: string[] = [];
  if (seatsResult === FAILED) failed.push('seats');
  if (chatgptSeatsResult === FAILED) failed.push('seats');
  if (officeResult === FAILED) failed.push('office');
  const seats = seatsResult === FAILED ? null : seatsResult;
  const chatgptSeats = chatgptSeatsResult === FAILED ? null : chatgptSeatsResult;
  const office = officeResult === FAILED ? null : officeResult;

  return NextResponse.json({ ...current, projection, projectionByVendor, insight, seats, chatgptSeats, office, failed });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps → Spend Review index: everyone's CCC-measured spend this month and, when an
// Admin API key with read:spend_limits is saved, each person's Anthropic
// limit, spend across every surface and any pending request for more usage.
// Admin and manager only (per-person cost is salary-adjacent).
import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { currentPeriod } from '@/lib/finance/period';
import { getTypedClient } from '@/lib/db/client';
import { cached, FRESH_MS, PAST_MONTH_FRESH_MS } from '@/lib/finance/spend-review-cache';
import { buildSpendReviewIndex, userIdsByEmail, peopleById, priorPeriod, type SpendReviewPerson } from '@/lib/finance/spend-review';
import { getSpendLimits, indexByEmail, primaryRow, shareUsed, NEAR_LIMIT_SHARE, type SpendLimitRow } from '@/lib/anthropic/spend-limits';

export const dynamic = 'force-dynamic';

interface IndexRow extends Omit<SpendReviewPerson, 'userId'> {
  /** Null for an Anthropic member CCC has never seen. */
  userId: string | null;
  anthropic: (SpendLimitRow & { shareUsed: number | null }) | null;
  pendingRequestAt: string | null;
}

export async function GET(request: NextRequest) {
  // Part of FinOps: hidden with it (finance pattern, 404 before auth).
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  if (!canAccessPulseAdmin(session.role)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'finance/spend-review', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const nowS = Math.floor(Date.now() / 1000);
  const thisMonth = currentPeriod(nowS);
  const period = request.nextUrl.searchParams.get('period') || thisMonth;
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'finance/spend-review', action: 'READ', outcome: 'success', detail: request.nextUrl.search || undefined });

  try {
    // Anthropic only reports the CURRENT period, so limits sit beside this month only.
    const isCurrent = period === thisMonth;
    const built = await cached(`index:${period}`, isCurrent ? FRESH_MS : PAST_MONTH_FRESH_MS,
      () => buildSpendReviewIndex(period, nowS), { force: request.nextUrl.searchParams.get('refresh') === '1' });
    const index = built.value;
    // Early in a month nobody has enough sessions for the efficiency board yet: show the
    // previous month's, labelled as such, rather than an empty board.
    let efficiency = index.efficiency;
    let efficiencyPeriod = period;
    if (isCurrent && efficiency.length === 0) {
      const prior = priorPeriod(period);
      const priorBuilt = await cached(`index:${prior}`, PAST_MONTH_FRESH_MS, () => buildSpendReviewIndex(prior, nowS));
      if (priorBuilt.value.efficiency.length) {
        efficiency = priorBuilt.value.efficiency;
        efficiencyPeriod = prior;
      }
    }
    const limits = await getSpendLimits();
    const { members, requests } = indexByEmail(limits);

    const rows: IndexRow[] = index.people.map(p => {
      const email = p.email?.toLowerCase() ?? null;
      const row = isCurrent && email ? primaryRow(members.get(email)) : null;
      return {
        ...p,
        anthropic: row ? { ...row, shareUsed: shareUsed(row) } : null,
        pendingRequestAt: email ? requests.get(email)?.createdAt ?? null : null,
      };
    });

    // Anthropic members with no CCC spend this month (Chat-only users, or
    // people CCC has never seen) still belong in a limits review.
    if (isCurrent && limits.status === 'ok') {
      const seen = new Set(rows.map(r => r.email?.toLowerCase()).filter(Boolean));
      const extra = limits.members.filter(m => m.email && !seen.has(m.email.toLowerCase()));
      const ids = await userIdsByEmail(extra.map(m => m.email!));
      const people = await peopleById(await getTypedClient(), [...ids.values()]);
      for (const m of extra) {
        const email = m.email!.toLowerCase();
        const userId = ids.get(email) ?? null;
        const p = userId ? people.get(userId) : undefined;
        const row = primaryRow(m);
        rows.push({
          userId,
          displayName: p?.displayName ?? m.name ?? m.email!,
          email: m.email,
          department: p?.department ?? null,
          codeUsd: 0,
          coworkUsd: 0,
          totalUsd: 0,
          priorTotalUsd: null,
          unpricedOnly: false,
          mainWork: null,
          routeCount: 0,
          anthropic: row ? { ...row, shareUsed: shareUsed(row) } : null,
          pendingRequestAt: requests.get(email)?.createdAt ?? null,
        });
      }
    }

    return NextResponse.json({
      period,
      isCurrentMonth: isCurrent,
      updatedAt: Math.floor(built.computedAt / 1000),
      people: rows,
      efficiency,
      efficiencyPeriod,
      summary: index.summary,
      unpricedModels: index.unpricedModels,
      limits: { status: limits.status, fetchedAt: limits.fetchedAt, pendingCount: limits.pendingRequests.length },
      nearLimitShare: NEAR_LIMIT_SHARE,
    });
  } catch (err) {
    return errorResponse('api/finance/spend-review', err, { message: 'Could not build the spend review.' });
  }
}

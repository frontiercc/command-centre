// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps → one person's Spend Review for a month. Admins and managers for anyone; each
// person for their own. Anthropic's limit and spend sit beside the current
// month only (the API reports the current period), and only when an Admin
// API key with read:spend_limits is saved.
import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { currentPeriod } from '@/lib/finance/period';
import { buildSpendReview } from '@/lib/finance/spend-review';
import { canViewSpendReview } from '@/lib/finance/spend-review-access';
import { cached, FRESH_MS, PAST_MONTH_FRESH_MS } from '@/lib/finance/spend-review-cache';
import { getSpendLimits, indexByEmail, primaryRow, shareUsed, NEAR_LIMIT_SHARE } from '@/lib/anthropic/spend-limits';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  // Part of FinOps: hidden with it (finance pattern, 404 before auth).
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = decodeURIComponent((await params).userId);
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  if (!(await canViewSpendReview(session, userId))) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'finance/spend-review', action: 'READ', outcome: 'denied', detail: userId });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const nowS = Math.floor(Date.now() / 1000);
  const thisMonth = currentPeriod(nowS);
  const period = request.nextUrl.searchParams.get('period') || thisMonth;
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'finance/spend-review', action: 'READ', outcome: 'success', detail: `${userId} ${period}` });

  try {
    const isCurrent = period === thisMonth;
    // The review is the same whoever looks at it; only canSeePrompts below depends on the viewer.
    const built = await cached(`review:${userId}:${period}`, isCurrent ? FRESH_MS : PAST_MONTH_FRESH_MS,
      () => buildSpendReview(userId, period, nowS), { force: request.nextUrl.searchParams.get('refresh') === '1' });
    const review = built.value;
    const limits = await getSpendLimits();
    const { members, requests } = indexByEmail(limits);
    const email = review.email?.toLowerCase() ?? null;
    const member = email ? members.get(email) : undefined;
    const row = isCurrent ? primaryRow(member) : null;
    return NextResponse.json({
      ...review,
      isCurrentMonth: isCurrent,
      updatedAt: Math.floor(built.computedAt / 1000),
      anthropic: {
        status: limits.status,
        fetchedAt: limits.fetchedAt,
        matched: !!member,
        limit: row ? { ...row, shareUsed: shareUsed(row) } : null,
        pendingRequestAt: email ? requests.get(email)?.createdAt ?? null : null,
      },
      nearLimitShare: NEAR_LIMIT_SHARE,
      // The session click-through shows prompts, which follow the Audit Log rule.
      canSeePrompts: canAccessPulseAdmin(session.role),
    });
  } catch (err) {
    return errorResponse('api/finance/spend-review/[userId]', err, { message: 'Could not build the spend review.' });
  }
}

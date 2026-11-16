// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Admin, Ask the data: the settings as saved, this month's measured spend and questions by
// outcome, and the latest questions from the log (never answers: they are not stored).
// The settings themselves are saved through /api/config like every other admin page.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getAllConfig, getConfigValue } from '@/lib/config';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { ASK_MODEL } from '@/lib/ask/run';
import { monthStart, outcomesThisMonth, recentQuestions, spendThisMonth } from '@/lib/ask/log';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession(request);
    if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const actorIp = request.headers.get('x-forwarded-for') || undefined;
    if (session.role !== 'admin') {
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'admin/ask', action: 'READ', outcome: 'denied' });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'admin/ask', action: 'READ', outcome: 'success' });
    const cfg = await getAllConfig();
    const nowS = Math.floor(Date.now() / 1000);
    return NextResponse.json({
      enabled: cfg.askEnabled === true,
      hasKey: !!(await getConfigValue('anthropicAiApiKey')),
      model: ASK_MODEL,
      monthlyCapUsd: cfg.askMonthlyCapUsd,
      retentionDays: cfg.askLogRetentionDays,
      month: { start: monthStart(nowS), spendUsd: await spendThisMonth(nowS), outcomes: await outcomesThisMonth(nowS) },
      questions: await recentQuestions(200),
    });
  } catch (err) {
    return errorResponse('admin/ask GET', err);
  }
}

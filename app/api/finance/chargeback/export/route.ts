// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildChargeback } from '@/lib/finance/chargeback';
import { currentPeriod } from '@/lib/finance/period';

export const dynamic = 'force-dynamic';

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCSV(cols: unknown[]): string {
  return cols.map(escapeCSV).join(',');
}

const money = (n: number) => n.toFixed(2);

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

  const report = await buildChargeback(period);

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/chargeback',
    action: 'EXPORT',
    outcome: 'success',
  });

  // With OpenAI connected the columns name each product and add ChatGPT and
  // Codex (priced at OpenAI's USD token rates); otherwise unchanged.
  const openai = report.vendors !== undefined;
  const lines: string[] = [];
  lines.push(rowToCSV(openai
    ? ['Cost Centre', 'User', 'Claude Code USD', 'Claude Cowork USD', 'ChatGPT USD', 'Codex USD', 'Total USD']
    : ['Cost Centre', 'User', 'Code USD', 'Cowork USD', 'Total USD']));

  let totalCode = 0;
  let totalCowork = 0;
  let totalChatgpt = 0;
  let totalCodex = 0;
  const row = (centre: string, user: (typeof report.unallocated.users)[number]) => {
    totalCode += user.codeUsd;
    totalCowork += user.coworkUsd;
    totalChatgpt += user.chatgptUsd ?? 0;
    totalCodex += user.codexUsd ?? 0;
    lines.push(rowToCSV(openai
      ? [centre, user.displayName, money(user.codeUsd), money(user.coworkUsd), money(user.chatgptUsd ?? 0), money(user.codexUsd ?? 0), money(user.totalUsd)]
      : [centre, user.displayName, money(user.codeUsd), money(user.coworkUsd), money(user.totalUsd)]));
  };

  for (const centre of report.costCentres) {
    for (const user of centre.users) row(centre.name, user);
  }
  for (const user of report.unallocated.users) row('Unallocated', user);

  lines.push(rowToCSV(openai
    ? ['TOTAL', '', money(totalCode), money(totalCowork), money(totalChatgpt), money(totalCodex), money(report.grandTotalUsd)]
    : ['TOTAL', '', money(totalCode), money(totalCowork), money(report.grandTotalUsd)]));

  const csv = lines.join('\n');
  const filename = `chargeback-${period}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { generateGovernanceReport } from '@/lib/anthropic/ai';
import { insertReport, getReports, getReportById } from '@/lib/db/queries';
import { v4 as uuidv4 } from 'uuid';
import { getAdminSession, canAccessCorePlatform, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getAllConfig } from '@/lib/config';
import { availableSections, REPORT_SECTIONS } from '@/lib/reports/section-catalog';
import { effectiveCodeHumanTime } from '@/lib/pulse/human-time';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const params = request.nextUrl.searchParams;
  const id = params.get('id');
  // Reports holding a cost section name people's spend: admins and managers
  // only, the same rule that limits who can generate them. Anyone else gets
  // the rest of the list; a direct read 404s.
  const includeManagerOnly = canAccessPulseAdmin(session.role);

  if (id) {
    const report = await getReportById(id, { includeManagerOnly });
    if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(report);
  }

  return NextResponse.json(await getReports(200, { includeManagerOnly }));
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const periodStart = body.period_start || getDefaultPeriodStart();
    const periodEnd = body.period_end || new Date().toISOString().split('T')[0];
    const reportType = body.report_type || 'on-demand';
    const generatedBy = session.displayName || session.email || 'unknown';

    // Section gating is enforced HERE, not in the picker: a flag-disabled or
    // role-restricted section must not generate even if the client asks for it.
    // Cost data is admin|manager only (salary-adjacent), matching /api/finance.
    // A request with no section list gets every section this caller may see,
    // never every section there is.
    const requested = Array.isArray(body.sections) ? body.sections : undefined;
    const cfg = await getAllConfig();
    const allowed = new Set(
      availableSections(
        {
          chargebackEnabled: Boolean(cfg.chargebackEnabled),
          useCasesEnabled: Boolean(cfg.useCasesEnabled),
          gdprApplicable: Boolean(cfg.gdprApplicable),
          lgpdApplicable: Boolean(cfg.lgpdApplicable),
          humanTimeEnabled: String(cfg.humanTimeEnabled) === 'true' || effectiveCodeHumanTime(cfg.humanTimeCodeEnabled as string, cfg.humanTimeEnabled as string),
        },
        canAccessPulseAdmin(session.role),
      ).map(s => s.id),
    );
    const sections = requested
      ? requested.filter((id: unknown): id is string => typeof id === 'string' && allowed.has(id))
      : [...allowed];
    const department = typeof body.department === 'string' ? body.department : undefined;
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'reports', action: 'WRITE', outcome: 'success', detail: `period=${periodStart}..${periodEnd}${department ? ` dept=${department}` : ''}` });
    const contentMd = await generateGovernanceReport(periodStart, periodEnd, sections, department);

    // Extract executive summary (first paragraph after first heading)
    const summaryMatch = contentMd.match(/## Executive Summary\s*\n([\s\S]*?)(?=\n##|\n$)/i);
    const contentSummary = summaryMatch
      ? summaryMatch[1].trim().slice(0, 500)
      : contentMd.slice(0, 200);

    const report = {
      id: uuidv4(),
      report_type: reportType,
      period_start: periodStart,
      period_end: periodEnd,
      generated_by: generatedBy,
      content_md: contentMd,
      content_summary: contentSummary,
      // Recorded so viewers never read it back from the list (R3).
      manager_only: sections.some((id: string) => REPORT_SECTIONS.find(d => d.id === id)?.managerOnly) ? 1 : 0,
    };

    await insertReport(report);

    return NextResponse.json({
      ...report,
      generated_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    return errorResponse('Report', err, { message: 'The AI request failed. Details are in the server log.' });
  }
}

function getDefaultPeriodStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

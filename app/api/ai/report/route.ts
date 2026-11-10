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
    // The dates go into the model's instructions, so anything that is not a
    // real calendar date is refused rather than passed on.
    if ((body.period_start && !isIsoDate(body.period_start)) || (body.period_end && !isIsoDate(body.period_end))) {
      return NextResponse.json({ error: 'period_start and period_end must be dates (YYYY-MM-DD)' }, { status: 400 });
    }
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

    // The executive summary is the text between its heading and the next heading.
    const summary = executiveSummary(contentMd);
    const contentSummary = summary ? summary.slice(0, 500) : contentMd.slice(0, 200);

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

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Text under "## Executive Summary" up to the next "##" heading, or null. A plain search, not a backtracking pattern. */
function executiveSummary(md: string): string | null {
  const heading = /## Executive Summary[^\n]*\n/i.exec(md);
  if (!heading) return null;
  const rest = md.slice(heading.index + heading[0].length);
  const end = rest.indexOf('\n##');
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null;
}

function getDefaultPeriodStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

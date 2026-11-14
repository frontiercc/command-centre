// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/pulse/code/so-what?department=&hires=: what a leader gets if they act, priced from
// the two groups in lib/pulse/code/output-groups.ts. The page carries no names, but it is read off
// per-person figures and it recommends decisions about headcount, so admin and manager only, and
// every read is access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { parseVendor } from '@/lib/dashboard/vendor';
import { getOutputGroups } from '@/lib/pulse/code/output-groups';
import { listDecisions } from '@/lib/pulse/code/decision-log';
import { getFinds } from '@/lib/pulse/code/so-what-finds';
import { buildSoWhat, type Question } from '@/lib/pulse/code/so-what';
import { coachingScope } from '@/lib/pulse/coaching-scope';

export const dynamic = 'force-dynamic';

/** How many engineers a team has asked for. A question, not a stored figure. */
const MAX_HIRES = 99;

function parseHires(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 1 || v > MAX_HIRES) return null;
  return Math.floor(v);
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  const log = (outcome: 'success' | 'denied', detail?: string) =>
    logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/so-what', action: 'READ', outcome, detail });
  if (!canAccessPulseAdmin(session.role)) {
    await log('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const vendor = parseVendor(request.nextUrl.searchParams.get('vendor'));
    const groups = await getOutputGroups(vendor);
    const all = groups.map(g => g.department);
    // A manager asks only about their own team, exactly as Team coaching scopes them.
    const scope = coachingScope(session, all, request.nextUrl.searchParams.get('department'));
    if ('error' in scope) {
      await log('denied', scope.error);
      return NextResponse.json({ error: scope.error }, { status: 403 });
    }
    const hires = parseHires(request.nextUrl.searchParams.get('hires'));
    const rawQuestion = request.nextUrl.searchParams.get('ask');
    const question: Question | null = rawQuestion === 'hire' || rawQuestion === 'backfill' ? rawQuestion : null;
    // Hiring needs a number; a backfill is always one person.
    const answerable = question === 'backfill' || (question === 'hire' && hires !== null);
    const asked = scope.department && question && answerable
      ? { department: scope.department, question, hires: hires ?? 1 }
      : null;
    await log('success', asked ? `department=${asked.department} ask=${asked.question} hires=${asked.hires}` : undefined);
    const out = buildSoWhat({
      groups: groups.filter(g => scope.teams.includes(g.department)),
      decisions: await listDecisions(),
      asked,
      // What the page found on its own is about the whole of engineering, so only a caller who
      // can see every team gets it.
      finds: scope.teams.length > 1 ? await getFinds(vendor) : undefined,
      nowS: Math.floor(Date.now() / 1000),
    });
    return NextResponse.json({ ...out, department: scope.department });
  } catch (err) {
    return errorResponse('pulse/code/so-what', err);
  }
}

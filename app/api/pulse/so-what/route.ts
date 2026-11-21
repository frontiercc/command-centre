// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/pulse/so-what?department=&ask=&hires=: Work Pulse's So What, what a leader gets if they
// act, priced from the two groups in lib/pulse/cowork/work-groups.ts and the finds in
// lib/pulse/cowork/so-what-finds.ts. The page carries no names, but it is read off per-person
// figures and it recommends decisions about headcount, so admin and manager only, and every read
// is access-logged. It has no All / Claude / ChatGPT switch: it reads every platform an admin has
// left visible.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { groupsByTeam, loadWorkData, peopleFrom } from '@/lib/pulse/cowork/work-groups';
import { getWorkFinds } from '@/lib/pulse/cowork/so-what-finds';
import { listDecisions } from '@/lib/pulse/code/decision-log';
import { buildSoWhat, workDecisions, type Question } from '@/lib/pulse/cowork/so-what';
import { coachingScope } from '@/lib/pulse/coaching-scope';
import { keptFigures } from '@/lib/kept-figures';
import { getTierNames } from '@/lib/pulse/tier-config';

export const dynamic = 'force-dynamic';

/** How many people a team has asked for. A question, not a stored figure. */
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
    logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/so-what', action: 'READ', outcome, detail });
  if (!canAccessPulseAdmin(session.role)) {
    await log('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const vendor = await visibleVendor(null);
    // Every judged prompt and session in the window: the same for every viewer, so built once and
    // kept for five minutes (lib/kept-figures.ts). Who sees which team is decided below.
    const data = await keptFigures(`so-what-data:${vendor}`, () => loadWorkData(vendor));
    const groups = groupsByTeam(peopleFrom(data));
    // A manager asks only about their own team, exactly as Team coaching scopes them.
    const scope = coachingScope(session, groups.map(g => g.department), request.nextUrl.searchParams.get('department'));
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
    const decisions = workDecisions(await listDecisions());
    const kept = new Set(decisions.map(d => `${d.card}\u0000${d.department}`));
    const out = buildSoWhat({
      groups: groups.filter(g => scope.teams.includes(g.department)),
      decisions,
      asked,
      // What the page finds on its own spans the organisation, so only a caller who can see every
      // team gets it.
      finds: scope.teams.length > 1
        // Kept per set of decisions, since a decided card stays on the page after it leaves the top.
        ? await keptFigures(
          `so-what-finds:${vendor}:${[...kept].sort().join('\u0001')}`,
          () => getWorkFinds(vendor, data, (card, department) => kept.has(`${card}\u0000${department}`)),
        )
        : undefined,
      nowS: Math.floor(Date.now() / 1000),
      tierNames: await getTierNames(),
    });
    return NextResponse.json({ ...out, department: scope.department });
  } catch (err) {
    return errorResponse('pulse/so-what', err);
  }
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spot-check of the by-hand estimates. Admin-only: the items
// carry each session's first prompt, so reads go through gateContentRead
// (access-logged). GET ?surface=code|cowork&period=YYYY-MM lists the month's
// sample; POST {action:'draw'|'review'} draws it or records one verdict.
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { gateContentRead } from '@/lib/auth/content-access';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { currentPeriod, drawChecks, listChecks, recordCheck, latestCheckResult, VERDICTS, type Surface, type Verdict } from '@/lib/pulse/human-time-checks';
import { MAX_HUMAN_MINUTES } from '@/lib/pulse/human-time';

export const dynamic = 'force-dynamic';

const RESOURCE = 'pulse/human-time-checks';

function parseSurface(v: unknown): Surface | null {
  return v === 'code' || v === 'cowork' ? v : null;
}

function parsePeriod(v: unknown): string {
  return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : currentPeriod();
}

export async function GET(request: NextRequest) {
  const gate = await gateContentRead(request, RESOURCE, { adminOnly: true });
  if ('response' in gate) return gate.response;
  const surface = parseSurface(request.nextUrl.searchParams.get('surface'));
  if (!surface) return NextResponse.json({ error: 'surface must be code or cowork' }, { status: 400 });
  const period = parsePeriod(request.nextUrl.searchParams.get('period'));
  try {
    return NextResponse.json({ surface, period, items: await listChecks(surface, period), latest: await latestCheckResult(surface) });
  } catch (err) {
    return errorResponse(RESOURCE, err);
  }
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'draw') {
      const surface = parseSurface(body.surface);
      if (!surface) return NextResponse.json({ error: 'surface must be code or cowork' }, { status: 400 });
      const period = parsePeriod(body.period);
      const count = await drawChecks(surface, period);
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: RESOURCE, action: 'WRITE', outcome: 'success', detail: `draw ${surface} ${period}` });
      return NextResponse.json({ ok: true, period, count });
    }
    if (body.action === 'review') {
      const id = Number(body.id);
      const verdict = body.verdict as Verdict;
      const corrected = body.correctedMinutes === null || body.correctedMinutes === undefined || body.correctedMinutes === ''
        ? null : Number(body.correctedMinutes);
      if (!Number.isInteger(id) || !VERDICTS.includes(verdict)) {
        return NextResponse.json({ error: 'id and verdict (about_right|too_high|too_low) required' }, { status: 400 });
      }
      if (corrected !== null && (!Number.isInteger(corrected) || corrected < 1 || corrected > MAX_HUMAN_MINUTES)) {
        return NextResponse.json({ error: `correctedMinutes must be a whole number from 1 to ${MAX_HUMAN_MINUTES}` }, { status: 400 });
      }
      const ok = await recordCheck(id, verdict, corrected);
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: RESOURCE, action: 'WRITE', outcome: ok ? 'success' : 'failure', detail: `review ${id}` });
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return errorResponse(RESOURCE, err);
  }
}

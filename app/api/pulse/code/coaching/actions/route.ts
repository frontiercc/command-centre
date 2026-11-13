// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST/DELETE /api/pulse/code/coaching/actions {department, key, note?}: a team lead marks a Team
// coaching action done (with an optional note of what the team did), or undoes it. The action's
// wording and the figure it is meant to move come from the team's current plan, never from the
// request, and that figure is saved as it stands today, for the team and for the organisation.
// Admins may mark any team's actions; a manager only their own department's. Every write is
// access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { getCoachingFigures } from '@/lib/pulse/code/coaching-figures';
import { findAction } from '@/lib/pulse/code/team-coaching';
import { markActionDone, undoActionDone } from '@/lib/pulse/code/coaching-store';
import { coachingScope } from '@/lib/pulse/code/coaching-scope';

export const dynamic = 'force-dynamic';

const MAX_LENGTH = 300;
const MAX_NOTE = 500;

async function parse(request: NextRequest): Promise<{ department: string; key: string; note: string | null } | null> {
  let body: unknown;
  try {
    body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return null;
  }
  const { department, key, note } = (body ?? {}) as { department?: unknown; key?: unknown; note?: unknown };
  if (typeof department !== 'string' || !department.trim() || department.length > MAX_LENGTH) return null;
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_LENGTH) return null;
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) return null;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return { department, key, note: trimmed || null };
}

type Session = Awaited<ReturnType<typeof getAdminSession>>;

function logger(request: NextRequest, session: Session) {
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  return (outcome: 'success' | 'denied' | 'failure', detail?: string) =>
    logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/coaching', action: 'WRITE', outcome, detail });
}

async function handle(request: NextRequest, session: Session, mode: 'done' | 'undo') {
  const log = logger(request, session);
  const body = await parse(request);
  if (!body) return NextResponse.json({ error: 'department and key are required' }, { status: 400 });
  try {
    const figures = await getCoachingFigures('all');
    const scope = coachingScope(session, figures.teams.map(t => t.department), body.department);
    if ('error' in scope || scope.department !== body.department) {
      await log('denied', `${mode} department=${body.department} key=${body.key}`);
      return NextResponse.json({ error: 'error' in scope ? scope.error : 'You can only coach your own team.' }, { status: 403 });
    }
    if (mode === 'undo') {
      await undoActionDone(body.department, body.key);
      await log('success', `undo department=${body.department} key=${body.key}`);
      return NextResponse.json({ ok: true });
    }
    const found = findAction(body.department, body.key, figures);
    if (!found) {
      await log('failure', `done department=${body.department} key=${body.key} not_suggested`);
      return NextResponse.json({ error: "This action isn't suggested for the team any more. Reload the page." }, { status: 409 });
    }
    await markActionDone({
      department: body.department,
      actionKey: found.action.key,
      actionText: found.action.text,
      metric: found.action.metric,
      baseline: found.baseline,
      orgBaseline: found.orgBaseline,
      note: body.note,
      doneBy: session.email ?? session.userId ?? 'admin',
      doneAt: Math.floor(Date.now() / 1000),
    });
    await log('success', `done department=${body.department} key=${body.key}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse('pulse/code/coaching/actions', err);
  }
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulseAdmin(session.role)) {
    await logger(request, session)('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return handle(request, session, 'done');
}

export async function DELETE(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulseAdmin(session.role)) {
    await logger(request, session)('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return handle(request, session, 'undo');
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST/DELETE /api/pulse/code/so-what/decisions {card, department, hires?, chosen, note?}: a leader
// takes one of the two decisions on a So what card, or undoes it. What was recommended, the
// headline and every figure on the card are read from the page's own figures, never from the
// request, so the record cannot be written to say something the page did not say. Admins decide
// for any team; a manager only their own. Every write is access-logged.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { parseVendor } from '@/lib/dashboard/vendor';
import { getOutputGroups } from '@/lib/pulse/code/output-groups';
import { getFinds } from '@/lib/pulse/code/so-what-finds';
import { recordDecision, undoDecision, listDecisions } from '@/lib/pulse/code/decision-log';
import { buildSoWhat, cardFigures, FOUND_CARDS, type CardKind, type Choice, type Question } from '@/lib/pulse/code/so-what';
import { coachingScope } from '@/lib/pulse/coaching-scope';

export const dynamic = 'force-dynamic';

const MAX_LENGTH = 300;
const MAX_NOTE = 500;
const ASKED_CARDS: Question[] = ['hire', 'backfill'];

/** A card id is a kind, or a kind and its subject ('standard_job:feature'). */
function knownCard(card: string): boolean {
  const kind = card.split(':')[0] as CardKind;
  return (ASKED_CARDS as string[]).includes(kind) || FOUND_CARDS.includes(kind);
}

interface Body { card: string; department: string; hires: number; chosen: Choice; note: string | null }

async function parse(request: NextRequest): Promise<Body | null> {
  let raw: unknown;
  try {
    raw = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return null;
  }
  const { card, department, hires, chosen, note } = (raw ?? {}) as Record<string, unknown>;
  if (typeof card !== 'string' || card.length > MAX_LENGTH || !knownCard(card)) return null;
  if (typeof department !== 'string' || !department.trim() || department.length > MAX_LENGTH) return null;
  if (chosen !== undefined && chosen !== 'go' && chosen !== 'hold') return null;
  const n = Number(hires ?? 1);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) return null;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return { card, department, hires: Math.floor(n), chosen: (chosen as Choice) ?? 'hold', note: trimmed || null };
}

type Session = Awaited<ReturnType<typeof getAdminSession>>;

function logger(request: NextRequest, session: Session) {
  const actorIp = request.headers.get('x-forwarded-for') || undefined;
  return (outcome: 'success' | 'denied' | 'failure', detail?: string) =>
    logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'pulse/code/so-what', action: 'WRITE', outcome, detail });
}

async function handle(request: NextRequest, session: Session, mode: 'decide' | 'undo') {
  const log = logger(request, session);
  const body = await parse(request);
  if (!body) return NextResponse.json({ error: 'card, department and chosen are required' }, { status: 400 });
  const where = `${mode} card=${body.card} department=${body.department}`;
  try {
    const vendor = parseVendor(request.nextUrl.searchParams.get('vendor'));
    const groups = await getOutputGroups(vendor);
    const scope = coachingScope(session, groups.map(g => g.department), body.department);
    if ('error' in scope || scope.department !== body.department) {
      await log('denied', where);
      return NextResponse.json({ error: 'error' in scope ? scope.error : 'You can only decide for your own team.' }, { status: 403 });
    }
    if (mode === 'undo') {
      await undoDecision(body.card, body.department);
      await log('success', where);
      return NextResponse.json({ ok: true });
    }

    // The card is rebuilt here so the stored record is the page's own wording and figures.
    const askedCard = (ASKED_CARDS as string[]).includes(body.card);
    const page = buildSoWhat({
      groups,
      decisions: await listDecisions(),
      asked: askedCard ? { department: body.department, question: body.card as Question, hires: body.hires } : null,
      finds: askedCard ? undefined : await getFinds(vendor),
      nowS: Math.floor(Date.now() / 1000),
    });
    const card = page.cards.find(c => c.cardId === body.card && c.department === body.department);
    if (!card) {
      await log('failure', `${where} no_card`);
      return NextResponse.json({ error: 'That card is not on the page any more. Reload it.' }, { status: 409 });
    }
    if (card.refusal) {
      await log('failure', `${where} refused`);
      return NextResponse.json({ error: 'This card cannot answer for this team, so there is nothing to decide.' }, { status: 409 });
    }
    await recordDecision({
      card: body.card,
      department: body.department,
      recommended: card.recommended,
      chosen: body.chosen,
      headline: card.headline,
      // An asked card freezes its two groups; a found card freezes the one figure it is judged on.
      figures: (card.groups
        ? cardFigures(card.groups)
        : { measure: card.measure }) as unknown as Record<string, unknown>,
      note: body.note,
      decidedBy: session.email ?? session.userId ?? 'admin',
      decidedAt: Math.floor(Date.now() / 1000),
    });
    await log('success', `${where} chosen=${body.chosen} recommended=${card.recommended}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse('pulse/code/so-what/decisions', err);
  }
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulseAdmin(session.role)) {
    await logger(request, session)('denied');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return handle(request, session, 'decide');
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

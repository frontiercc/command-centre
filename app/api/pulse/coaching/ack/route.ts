// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST/DELETE /api/pulse/coaching/ack — "Mark done" (and its undo) on a
// Coaching Prompts row. POST records that a manager
// has had the conversation with this person about this use case; the pair is
// excluded from spread candidates / coaching prompts / coaching counts
// everywhere, permanently (lib/usecases/spread.ts's acknowledgeCoachingPrompt
// + readAcked — no expiry unless asked for later). DELETE reverses it — the
// CoachingPrompts card gives a 5-second Undo window after Mark done.
import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getUserById } from '@/lib/db/queries';
import { getUseCase } from '@/lib/usecases/queries';
import { acknowledgeCoachingPrompt, unacknowledgeCoachingPrompt } from '@/lib/usecases/spread';

export const dynamic = 'force-dynamic';

interface ParsedBody { userId: string; useCaseId: string }

const MAX_ID_LENGTH = 200;

async function parseBody(request: NextRequest): Promise<ParsedBody | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { userId, useCaseId } = body as { userId?: unknown; useCaseId?: unknown };
  if (
    typeof userId !== 'string' || userId.trim() === '' || userId.length > MAX_ID_LENGTH ||
    typeof useCaseId !== 'string' || useCaseId.trim() === '' || useCaseId.length > MAX_ID_LENGTH
  ) {
    return NextResponse.json({ error: 'userId and useCaseId are required' }, { status: 400 });
  }
  return { userId, useCaseId };
}

export async function POST(request: NextRequest) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = await parseBody(request);
  if (parsed instanceof NextResponse) return parsed;
  const { userId, useCaseId } = parsed;

  // Existence checks — a bare FK failure would 500, and give the caller no
  // signal about which id was wrong.
  const [user, useCase] = await Promise.all([getUserById(userId), getUseCase(useCaseId)]);
  if (!useCase) return NextResponse.json({ error: 'Use case not found' }, { status: 404 });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await acknowledgeCoachingPrompt(userId, useCaseId, session.email ?? session.userId ?? 'admin');

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'pulse/coaching',
    action: 'WRITE',
    outcome: 'success',
    detail: `ack user=${userId} useCase=${useCaseId}`,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = await parseBody(request);
  if (parsed instanceof NextResponse) return parsed;
  const { userId, useCaseId } = parsed;

  await unacknowledgeCoachingPrompt(userId, useCaseId);

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'pulse/coaching',
    action: 'WRITE',
    outcome: 'success',
    detail: `un-ack user=${userId} useCase=${useCaseId}`,
  });

  return NextResponse.json({ ok: true });
}

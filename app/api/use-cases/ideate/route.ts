// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { ideateTurn, gatherOrgGrounding, type ChatTurn, type IdeateMode } from '@/lib/usecases/ideate';

export const dynamic = 'force-dynamic';

function isValidHistory(value: unknown): value is ChatTurn[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    item =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).role !== undefined &&
      ((item as Record<string, unknown>).role === 'user' || (item as Record<string, unknown>).role === 'assistant') &&
      typeof (item as Record<string, unknown>).content === 'string'
  );
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

  const body = await request.json().catch(() => null);
  if (!body || !isValidHistory(body.history)) {
    return NextResponse.json({ error: 'history is required' }, { status: 400 });
  }
  if (body.history.length === 0) {
    return NextResponse.json({ error: 'history required' }, { status: 400 });
  }

  const mode: IdeateMode = body.mode === 'scratch' ? 'scratch' : 'telemetry';

  try {
    const grounding = await gatherOrgGrounding();
    const result = await ideateTurn(body.history, mode, grounding);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse('UseCases ideate', err, { message: 'The AI request failed. Details are in the server log.' });
  }
}

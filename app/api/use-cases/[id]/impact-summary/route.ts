// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getUseCase } from '@/lib/usecases/queries';
import { buildUseCaseImpact } from '@/lib/usecases/impact';
import { generateImpactSummary, saveImpactSummary } from '@/lib/usecases/impact-summary';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id } = await params;
  const uc = await getUseCase(decodeURIComponent(id));
  if (!uc) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const nowS = Math.floor(Date.now() / 1000);
  const impact = await buildUseCaseImpact(uc.id, nowS);
  const { text } = await generateImpactSummary(uc.id, uc.title, impact);

  if (text === null) {
    return NextResponse.json({ error: 'Summary generation failed' }, { status: 502 });
  }

  await saveImpactSummary(uc.id, text, nowS);
  return NextResponse.json({ summary: text, generatedAt: nowS });
}

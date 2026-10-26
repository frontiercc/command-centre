// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getUseCase, updateUseCase } from '@/lib/usecases/queries';
import { activateUseCase } from '@/lib/usecases/match';
import { bootstrapUseCase } from '@/lib/usecases/tracker';

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

  const evidence = await activateUseCase(uc);

  const now = Math.floor(Date.now() / 1000);

  await updateUseCase(uc.id, {
    activateResult: evidence,
    lastActivatedAt: now,
  });

  // Immediate lifecycle refresh via the same single-writer tracker path;
  // non-fatal — the scheduled tracker sweep will cover it on the next cycle.
  try { await bootstrapUseCase(uc.id); } catch { /* non-fatal: tracker sweep will cover it */ }

  return NextResponse.json({ evidence });
}

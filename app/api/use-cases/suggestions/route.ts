// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { listOpenSuggestions } from '@/lib/usecases/suggestion-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cfg = await getAllConfig();
  if (cfg.useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Process suggestions only: rows from the retired org-wide tool-combination
  // tray (department NULL, no canvas) stay in the table but are not shown.
  // Switching content analysis off hides the department rows too: filtered,
  // never deleted, so switching it back on restores them.
  if (cfg.useCasesSuggestUseContent !== 'true') return NextResponse.json([]);
  const rows = await listOpenSuggestions();
  // Cross-department process suggestions are department NULL with a
  // canvas; the retired tray's rows have no canvas and stay hidden.
  return NextResponse.json(rows.filter(r => r.department !== null || r.canvas !== null));
}

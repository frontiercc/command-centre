// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { exportUserData, insertAlert } from '@/lib/db/queries';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { personLabel } from '@/lib/alerts/person-label';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const userId = request.nextUrl.searchParams.get('id');
  if (!userId) {
    return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
  }

  const data = await exportUserData(userId);
  if (!data) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // The alert has no person attached, so the Alerts page cannot swap a name
  // in: write the name, never the raw id.
  const exportedName = await personLabel(userId);

  // Audit trail — insertAlert signature is Omit<Alert, 'generated_at' | 'resolved_at' | 'resolved_by' | 'status'>
  await insertAlert({
    id: crypto.randomUUID(),
    user_id: null,
    alert_type: 'policy',
    severity: 'low',
    title: 'User data exported',
    explanation: `Data for ${exportedName} exported by admin on ${new Date().toISOString()}.`,
    raw_evidence: null,
  });

  const filename = `user-export-${userId}-${new Date().toISOString().split('T')[0]}.json`;
  const json = JSON.stringify(data, null, 2);

  return new NextResponse(json, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { generateSupportBundle } from '@/lib/support/bundle';
import { insertErrorEvents } from '@/lib/db/error-queries';
import { requireAdmin } from '@/lib/auth/admin-auth';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  try {
    const buffer = await generateSupportBundle();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    insertErrorEvents([{
      severity: 'info',
      source: 'dashboard',
      message: 'Support bundle generated',
      context_json: JSON.stringify({ size_bytes: buffer.length }),
    }]);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename=ccc-support-bundle-${timestamp}.zip`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    return errorResponse('Support Bundle', err);
  }
}

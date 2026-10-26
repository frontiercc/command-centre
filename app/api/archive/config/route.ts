// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { requireAdmin, getAdminSession } from '@/lib/auth/admin-auth';

const MASKED_KEYS = ['archiveAccessKeyId', 'archiveSecretAccessKey'] as const;

// Match existing masking pattern from app/api/config/route.ts
function maskValue(value: string): string {
  if (!value || value.length < 8) return value ? '••••••••' : '';
  return value.slice(0, 7) + '••••••••';
}

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Archive settings — admin only (admin data/overview pages).
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const config = {
      archiveEnabled: (await getConfigValue('archiveEnabled')) === 'true',
      archiveProvider: await getConfigValue('archiveProvider'),
      archiveBucket: await getConfigValue('archiveBucket'),
      archiveRegion: await getConfigValue('archiveRegion'),
      archiveAccessKeyId: maskValue(await getConfigValue('archiveAccessKeyId')),
      archiveSecretAccessKey: maskValue(await getConfigValue('archiveSecretAccessKey')),
    };

    return NextResponse.json(config);
  } catch (err) {
    return errorResponse('api/archive/config GET', err);
  }
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  try {
    const body = await request.json();

    const fields = ['archiveEnabled', 'archiveProvider', 'archiveBucket', 'archiveRegion', 'archiveAccessKeyId', 'archiveSecretAccessKey'] as const;

    for (const field of fields) {
      if (body[field] !== undefined) {
        const value = String(body[field]);
        // Skip masked values (user didn't change the field) -- matches existing pattern
        if (MASKED_KEYS.includes(field as typeof MASKED_KEYS[number]) && value.includes('••••••••')) {
          continue;
        }
        await setConfigValue(field, value);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse('api/archive/config POST', err, { message: 'Could not save the archive settings. Details are in the server log.' });
  }
}

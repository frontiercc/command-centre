// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — send test.
 *
 * Admin-only. Delivers buildDigest() (or SAMPLE_DIGEST_DATA when there is
 * no completed week yet — see lib/digest/sample.ts) over whichever
 * channels are configured, using the exact same sendDigest() path the
 * Monday scheduler uses (lib/digest/deliver.ts). Never writes
 * digestLastSentWeek — a test send must not affect the real weekly
 * schedule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, logError } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { buildDigest } from '@/lib/digest/build';
import { sendDigest } from '@/lib/digest/deliver';
import { SAMPLE_DIGEST_DATA } from '@/lib/digest/sample';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const built = await buildDigest();
    const data = built ?? SAMPLE_DIGEST_DATA;
    const hubUrl = (await getConfigValue('digestHubUrl')) || 'http://localhost:3001';
    const result = await sendDigest(data, hubUrl);

    // Keep which channel failed ("email:" / "slack:"); the library's text goes to the log.
    const errors = result.errors.map(e => {
      logError('api/admin/digest/test', e);
      const channel = e.split(':')[0];
      return `${channel}: send failed. Details are in the server log.`;
    });
    return NextResponse.json({ ok: true, isSample: built === null, ...result, errors });
  } catch (err) {
    return errorResponse('api/admin/digest/test', err, { message: 'Test send failed: check the email (SMTP) and Slack settings. Details are in the server log.' });
  }
}

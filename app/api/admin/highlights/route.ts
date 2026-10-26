// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — admin card status. NOT flag-gated (the card needs the
 * current state to render its enable toggle); admin-only. Config values are
 * saved through POST /api/config (keys in allowedKeys), not here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  return NextResponse.json({
    enabled: (await getConfigValue('highlightsEnabled')) === 'true',
    model: (await getConfigValue('highlightsModel')) || 'claude-sonnet-5',
    includeNames: (await getConfigValue('highlightsIncludeNames')) === 'true',
    slackConfigured: !!(await getConfigValue('digestSlackWebhookUrl')),
  });
}

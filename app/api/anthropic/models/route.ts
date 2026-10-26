// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) {
    return NextResponse.json({ models: [], error: 'No API key configured' });
  }

  try {
    const client = createAnthropicClient(apiKey);
    const page = await client.models.list();
    const models = page.data
      .map(m => ({ id: m.id, display_name: (m as { display_name?: string }).display_name || m.id }))
      .sort((a, b) => b.id.localeCompare(a.id));
    return NextResponse.json({ models });
  } catch (err) {
    // Always HTTP 200 for admins: the UI falls back to the saved model value.
    return errorResponse('api/anthropic/models', err, { status: 200, extra: { models: [] } });
  }
}

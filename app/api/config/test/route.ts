// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { getConfigValue } from '@/lib/config';
import { requireAdmin } from '@/lib/auth/admin-auth';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const { key, value } = await request.json();

  const fourDaysAgo = new Date(Date.now() - 4 * 86400_000).toISOString().split('T')[0];
  const keyMap: Record<string, { configKey: string; endpoint: string }> = {
    anthropicAdminApiKey: {
      configKey: 'anthropicAdminApiKey',
      endpoint: 'https://api.anthropic.com/v1/organizations/users?limit=1',
    },
    anthropicAnalyticsApiKey: {
      configKey: 'anthropicAnalyticsApiKey',
      endpoint: `https://api.anthropic.com/v1/organizations/analytics/users?date=${fourDaysAgo}&limit=1`,
    },
    anthropicAiApiKey: {
      configKey: 'anthropicAiApiKey',
      endpoint: 'https://api.anthropic.com/v1/models?limit=1',
    },
    complianceAccessKey: {
      configKey: 'complianceAccessKey',
      endpoint: 'https://api.anthropic.com/v1/compliance/apps/chats?limit=1',
    },
    // Same Admin API key, checked for the read:spend_limits scope (Spend Review).
    anthropicAdminApiKeySpendLimits: {
      configKey: 'anthropicAdminApiKey',
      endpoint: 'https://api.anthropic.com/v1/organizations/spend_limits/effective?limit=1',
    },
  };

  const config = keyMap[key];
  if (!config) {
    return NextResponse.json({ ok: false, error: 'Unknown key' });
  }

  // Prefer the value sent from the form (test-before-save), fall back to saved DB value
  const apiKey = (typeof value === 'string' && value.trim()) ? value.trim() : await getConfigValue(config.configKey as 'anthropicAdminApiKey' | 'anthropicAnalyticsApiKey' | 'anthropicAiApiKey' | 'complianceAccessKey');
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'Key not configured' });
  }

  try {
    const res = await fetch(config.endpoint, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });

    if (res.ok) return NextResponse.json({ ok: true });
    if (res.status === 401) return NextResponse.json({ ok: false, error: 'Invalid key' });
    if (res.status === 403) return NextResponse.json({ ok: false, error: key === 'anthropicAdminApiKeySpendLimits' ? 'Key is valid but cannot read spend limits: it needs read:spend_limits, an Enterprise plan and usage credits turned on' : 'Key is valid but missing the required scope or plan' });
    // Anything else, 404 included, is a failure: say so with the status Anthropic gave.
    const hint = key === 'anthropicAiApiKey' ? ' Check it was created inside a workspace in the Claude Console.' : '';
    return NextResponse.json({ ok: false, error: `Anthropic did not accept the key (status ${res.status}).${hint}` });
  } catch (err) {
    logError('api/config/test', err);
    return NextResponse.json({ ok: false, error: 'Could not reach Anthropic. Details are in the server log.' });
  }
}

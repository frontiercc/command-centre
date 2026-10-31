// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { getConfigValue } from '@/lib/config';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { listLogFiles, OpenAiApiError, type OpenAiEventType } from '@/lib/openai/client';

/**
 * OpenAI's Admin API key is checked by listing one file of each log type the
 * sync reads. Scopes are per log type, so a key can read one and not the other;
 * the reply names each type the key cannot read.
 */
async function testOpenAiKey(formKey: string | undefined, formWorkspace: string | undefined) {
  const apiKey = formKey?.trim() || await getConfigValue('openaiAdminApiKey');
  const workspaceId = formWorkspace?.trim() || (await getConfigValue('openaiWorkspaceId')).trim();
  if (!apiKey) return NextResponse.json({ ok: false, error: 'Key not configured' });
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'Enter the ChatGPT workspace ID first' });

  const after = new Date(Date.now() - 3600_000).toISOString();
  const labels: Record<string, string> = { CONVERSATION_MESSAGE: 'ChatGPT conversations', CODEX_LOG: 'Codex logs' };
  const missing: string[] = [];
  for (const type of ['CONVERSATION_MESSAGE', 'CODEX_LOG'] as OpenAiEventType[]) {
    try {
      await listLogFiles(apiKey, { kind: 'workspace', id: workspaceId }, type, after, 1);
    } catch (err) {
      if (err instanceof OpenAiApiError) {
        if (err.status === 401) return NextResponse.json({ ok: false, error: 'Invalid key' });
        if (err.status === 404) return NextResponse.json({ ok: false, error: 'OpenAI did not find this workspace ID' });
        if (err.status === 403) { missing.push(labels[type]); continue; }
        return NextResponse.json({ ok: false, error: `OpenAI did not accept the request (status ${err.status}).` });
      }
      logError('api/config/test', err);
      return NextResponse.json({ ok: false, error: 'Could not reach OpenAI. Details are in the server log.' });
    }
  }
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, error: `Key is valid but cannot read ${missing.join(' or ')}: it needs the matching Compliance Logs Platform read permission` });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const { key, value, workspaceId } = await request.json();

  if (key === 'openaiAdminApiKey') {
    return testOpenAiKey(typeof value === 'string' ? value : undefined, typeof workspaceId === 'string' ? workspaceId : undefined);
  }

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

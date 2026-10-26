// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * High-Priority Alerts -> Slack — send test.
 *
 * Admin-only. Posts a synthetic high-severity alert through the exact same
 * renderAlertSlack + postToSlackWebhook path notifyAlertSlack uses, reading
 * the currently SAVED webhook URL (not any unsaved value on the admin
 * page) — same contract as /api/admin/digest/test. Ignores
 * alertsSlackEnabled so an admin can verify the webhook before turning the
 * feature on.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { renderAlertSlack } from '@/lib/alerts/render-slack';
import { postToSlackWebhook } from '@/lib/slack/webhook';
import type { Alert } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

function sampleAlert(): Alert {
  return {
    id: 'test-alert',
    user_id: null,
    alert_type: 'code_cost_spike',
    severity: 'high',
    title: 'Test alert: Claude Code spend spike of $30.00 in 24h',
    explanation: 'This is a test notification from Command Centre. If you can see this in Slack, the webhook is configured correctly.',
    raw_evidence: null,
    status: 'open',
    generated_at: Math.floor(Date.now() / 1000),
    resolved_at: null,
    resolved_by: null,
  };
}

export async function POST(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  const webhookUrl = (await getConfigValue('alertsSlackWebhookUrl')) || '';
  if (!webhookUrl) {
    return NextResponse.json({ error: 'No Slack webhook URL configured. Save one first' }, { status: 400 });
  }

  const hubUrl = (await getConfigValue('digestHubUrl')) || 'http://localhost:3001';
  const payload = renderAlertSlack(sampleAlert(), hubUrl);
  const result = await postToSlackWebhook(webhookUrl, payload);

  if (!result.ok) {
    logError('api/admin/alerts-slack/test', result.error ?? 'Slack post failed');
    return NextResponse.json({ error: 'Slack post failed: check the webhook URL. Details are in the server log.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

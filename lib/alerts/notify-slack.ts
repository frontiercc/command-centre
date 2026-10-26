// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * High-priority alert -> Slack push. Fires for severity >= 'high' when
 * alertsSlackEnabled is on and a webhook URL is configured. Never throws —
 * called once per swept row by the hourly sweep job
 * (lib/alerts/slack-sweep.ts), which reads the alerts table directly rather
 * than hooking any generator's insert call, so a Slack outage never blocks
 * alert creation.
 */
import { getConfigValue } from '@/lib/config';
import type { Alert } from '@/lib/db/queries';
import { severityAtLeast } from '@/lib/alerts/severity';
import { renderAlertSlack } from '@/lib/alerts/render-slack';
import { postToSlackWebhook } from '@/lib/slack/webhook';

export async function notifyAlertSlack(alert: Alert): Promise<void> {
  if (!severityAtLeast(alert.severity, 'high')) return;

  try {
    if ((await getConfigValue('alertsSlackEnabled')) !== 'true') return;

    const webhookUrl = (await getConfigValue('alertsSlackWebhookUrl')) || '';
    if (!webhookUrl) return;

    const hubUrl = (await getConfigValue('digestHubUrl')) || 'http://localhost:3001';
    const payload = renderAlertSlack(alert, hubUrl);
    const result = await postToSlackWebhook(webhookUrl, payload);
    if (!result.ok) {
      console.error(`[alerts-slack] failed to notify Slack for alert ${alert.id}: ${result.error}`);
    }
  } catch (err) {
    console.error(`[alerts-slack] unexpected error notifying Slack for alert ${alert.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

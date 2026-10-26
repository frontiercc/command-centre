// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — Monday scheduler job.
 *
 * Decides whether the digest is due (`shouldSendDigest`) and runs the job
 * (`runDigestJob`): build the content, deliver it over whichever channels
 * are configured, and record `digestLastSentWeek` only when at least one
 * channel actually sent — so a both-channels-failed run is retried on the
 * next scheduler cycle rather than being silently marked done.
 */
import { getConfigValue, setConfigValue } from '@/lib/config';
import { isSmtpConfigured } from '@/lib/email/smtp';
import { weekStart } from '@/lib/pulse/period';
import { buildDigest } from '@/lib/digest/build';
import { sendDigest } from '@/lib/digest/deliver';

const DEFAULT_SEND_HOUR_UTC = 7;
const DEFAULT_HUB_URL = 'http://localhost:3001';

async function getSendHourUtc(): Promise<number> {
  const raw = parseInt(await getConfigValue('digestSendHourUtc'), 10);
  return Number.isNaN(raw) ? DEFAULT_SEND_HOUR_UTC : raw;
}

async function hasChannelConfigured(): Promise<boolean> {
  const slackConfigured = !!(await getConfigValue('digestSlackWebhookUrl'));
  const emailConfigured = (await isSmtpConfigured()) && !!(await getConfigValue('digestRecipients'));
  return slackConfigured || emailConfigured;
}

/**
 * True iff the digest is enabled, at least one delivery channel is
 * configured, it's Monday UTC at/after the configured send hour, and this
 * calendar week hasn't already been sent.
 */
export async function shouldSendDigest(now: number): Promise<boolean> {
  if ((await getConfigValue('digestEnabled')) !== 'true') return false;
  if (!(await hasChannelConfigured())) return false;

  const d = new Date(now * 1000);
  if (d.getUTCDay() !== 1) return false; // 1 = Monday
  if (d.getUTCHours() < (await getSendHourUtc())) return false;

  const lastSentWeek = await getConfigValue('digestLastSentWeek');
  if (lastSentWeek === String(weekStart(now))) return false;

  return true;
}

/**
 * Run the digest job when due. No-op (with a log line) when not due, when
 * there is nothing to send, or when it's not yet time. Only marks the week
 * as sent when at least one channel reports 'sent' — a total failure leaves
 * `digestLastSentWeek` untouched so the next scheduler cycle retries.
 */
export async function runDigestJob(now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!(await shouldSendDigest(now))) return;

  const data = await buildDigest(now);
  if (!data) {
    console.log('[Digest] Nothing to send for the completed week, skipping.');
    return;
  }

  const hubUrl = (await getConfigValue('digestHubUrl')) || DEFAULT_HUB_URL;
  const result = await sendDigest(data, hubUrl);

  console.log(`[Digest] Delivery result: email: ${result.email}, slack: ${result.slack}`);
  if (result.errors.length > 0) {
    console.warn('[Digest] Delivery errors:', result.errors);
  }

  if (result.email === 'sent' || result.slack === 'sent') {
    await setConfigValue('digestLastSentWeek', String(weekStart(now)));
  } else {
    console.warn('[Digest] No channel succeeded. digestLastSentWeek not updated, will retry next cycle.');
  }
}

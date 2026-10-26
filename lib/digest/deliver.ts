// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — delivery.
 *
 * Sends the already-rendered digest (lib/digest/render.ts) over email and/or
 * Slack. Each channel is independent: unconfigured -> 'skipped', any error
 * -> 'failed' with the message captured (never thrown), and both channels
 * are attempted even if one fails. No new email transport is created here —
 * email reuses the exact nodemailer factory + SMTP config keys already used
 * by lib/email/smtp.ts (password reset) so there is a single source of
 * truth for SMTP wiring.
 */
import { getConfigValue } from '@/lib/config';
import { createTransport, isSmtpConfigured } from '@/lib/email/smtp';
import type { DigestData } from '@/lib/digest/build';
import { renderDigestHtml, renderDigestSlack } from '@/lib/digest/render';
import { postToSlackWebhook } from '@/lib/slack/webhook';

const DAY = 86400;

export interface DeliveryResult {
  email: 'sent' | 'skipped' | 'failed';
  slack: 'sent' | 'skipped' | 'failed';
  errors: string[];
}

// Same shape check used elsewhere for "does this look like an email" —
// intentionally simple (basic shape only, not full RFC 5322 validation).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && EMAIL_RE.test(s));
}

function formatDateRange(weekStart: number, weekEnd: number): string {
  const start = new Date(weekStart * 1000);
  const end = new Date((weekEnd - DAY) * 1000); // weekEnd is exclusive; last day is Sunday
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)}–${fmt(end)}`;
}

async function deliverEmail(data: DigestData, hubUrl: string, errors: string[]): Promise<'sent' | 'skipped' | 'failed'> {
  if (!(await isSmtpConfigured())) return 'skipped';

  const recipients = parseRecipients((await getConfigValue('digestRecipients')) || '');
  if (recipients.length === 0) return 'skipped';

  try {
    const fromName = (await getConfigValue('smtpFromName')) || 'Frontier Command Centre';
    const fromAddress = await getConfigValue('smtpFromAddress');
    const dateRange = formatDateRange(data.weekStart, data.weekEnd);
    const html = renderDigestHtml(data, hubUrl);

    const transport = await createTransport();
    await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: recipients.join(', '),
      subject: `Your AI week: ${dateRange}`,
      html,
    });
    return 'sent';
  } catch (err) {
    errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}

async function deliverSlack(data: DigestData, hubUrl: string, errors: string[]): Promise<'sent' | 'skipped' | 'failed'> {
  const webhookUrl = (await getConfigValue('digestSlackWebhookUrl')) || '';
  if (!webhookUrl) return 'skipped';

  try {
    const payload = renderDigestSlack(data, hubUrl);
    const result = await postToSlackWebhook(webhookUrl, payload);
    if (!result.ok) {
      errors.push(`slack: ${result.error}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    errors.push(`slack: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}

/**
 * Deliver a rendered digest over email and/or Slack. Each channel is
 * attempted independently and never throws — failures are captured in
 * `errors` and reflected in the per-channel status.
 */
export async function sendDigest(data: DigestData, hubUrl: string): Promise<DeliveryResult> {
  const errors: string[] = [];

  const [email, slack] = await Promise.all([
    deliverEmail(data, hubUrl, errors),
    deliverSlack(data, hubUrl, errors),
  ]);

  return { email, slack, errors };
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — admin config status/save.
 *
 * GET returns the five UI-editable keys (Slack webhook masked, matching the
 * app/api/archive/config/route.ts convention), digestLastSentWeek, a
 * human-readable nextSendPreview, and per-channel configured flags so the
 * admin card can render "Email: configured / not configured" without
 * duplicating the hasChannelConfigured() logic from lib/digest/schedule.ts.
 *
 * PUT saves the five keys with the same validation app/api/config/route.ts
 * applies to the same keys (hour 0-23, https-only webhook) — kept in sync
 * deliberately rather than importing, since this route owns a narrower,
 * digest-specific surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { requireAdmin, getAdminSession } from '@/lib/auth/admin-auth';
import { isSmtpConfigured } from '@/lib/email/smtp';
import { weekStart } from '@/lib/pulse/period';

const MASKED_KEYS = ['digestSlackWebhookUrl'] as const;

// Match existing masking pattern from app/api/config/route.ts / app/api/archive/config/route.ts
function maskValue(value: string): string {
  if (!value || value.length < 8) return value ? '••••••••' : '';
  return value.slice(0, 7) + '••••••••';
}

function isValidWebhookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Human-readable summary of when the digest will next fire. */
async function nextSendPreview(now: number): Promise<string> {
  if ((await getConfigValue('digestEnabled')) !== 'true') return 'disabled';

  const slackConfigured = !!(await getConfigValue('digestSlackWebhookUrl'));
  const emailConfigured = (await isSmtpConfigured()) && !!(await getConfigValue('digestRecipients'));
  if (!slackConfigured && !emailConfigured) return 'no delivery channel configured';

  const sendHourRaw = parseInt(await getConfigValue('digestSendHourUtc'), 10);
  const sendHour = Number.isNaN(sendHourRaw) ? 7 : sendHourRaw;
  const hourLabel = String(sendHour).padStart(2, '0');

  const currentWeek = weekStart(now);
  const lastSentWeek = await getConfigValue('digestLastSentWeek');
  if (lastSentWeek === String(currentWeek)) return 'already sent this week';

  return `next eligible: Monday ≥${hourLabel}:00 UTC`;
}

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const recipients = await getConfigValue('digestRecipients');
    const webhookUrl = await getConfigValue('digestSlackWebhookUrl');

    const config = {
      digestEnabled: (await getConfigValue('digestEnabled')) === 'true',
      digestSendHourUtc: parseInt(await getConfigValue('digestSendHourUtc'), 10) || 7,
      digestRecipients: recipients,
      digestSlackWebhookUrl: maskValue(webhookUrl),
      digestHubUrl: (await getConfigValue('digestHubUrl')) || 'http://localhost:3001',
      digestLastSentWeek: (await getConfigValue('digestLastSentWeek')) || null,
      nextSendPreview: await nextSendPreview(now),
      channels: {
        email: (await isSmtpConfigured()) && !!recipients,
        slack: !!webhookUrl,
      },
    };

    return NextResponse.json(config);
  } catch (err) {
    return errorResponse('api/admin/digest', err);
  }
}

export async function PUT(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate send hour (0-23) — same rule as app/api/config/route.ts
  if (body.digestSendHourUtc !== undefined) {
    const v = parseInt(String(body.digestSendHourUtc), 10);
    if (isNaN(v) || v < 0 || v > 23) {
      return NextResponse.json({ error: 'digestSendHourUtc must be 0–23' }, { status: 400 });
    }
  }

  // Validate Slack webhook URL (https-only) unless it's the masked placeholder
  // (user left the field untouched) or blank (see Remove-only note below).
  if (body.digestSlackWebhookUrl !== undefined) {
    const raw = String(body.digestSlackWebhookUrl);
    if (raw !== '' && !raw.includes('••••••••') && !isValidWebhookUrl(raw)) {
      return NextResponse.json({ error: 'digestSlackWebhookUrl must be a valid https URL' }, { status: 400 });
    }
  }

  try {
    const fields = ['digestEnabled', 'digestSendHourUtc', 'digestRecipients', 'digestSlackWebhookUrl', 'digestHubUrl'] as const;

    for (const field of fields) {
      if (body[field] === undefined) continue;
      const value = String(body[field]);
      // Skip masked values (user didn't change the field) — matches
      // app/api/archive/config/route.ts's convention.
      if (MASKED_KEYS.includes(field as typeof MASKED_KEYS[number]) && value.includes('••••••••')) {
        continue;
      }
      // Remove-only: a blank digestSlackWebhookUrl (empty or whitespace-only)
      // is never treated as an intentional clear — blanking the field + Save
      // must never clear a stored secret. DELETE /api/config/secret is the
      // only clear path for this key.
      if (field === 'digestSlackWebhookUrl' && value.trim() === '') {
        continue;
      }
      await setConfigValue(field, value);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse('api/admin/digest', err);
  }
}

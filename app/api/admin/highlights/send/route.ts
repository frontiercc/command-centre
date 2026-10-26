// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — send the ADMIN-EDITED body to the digest's Slack
 * webhook. Sends exactly what the human approved (the request body), never a
 * regenerated draft. Flag-404 before auth; admin-only; logAccess-audited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { postToSlackWebhook } from '@/lib/slack/webhook';
import { logAccess } from '@/lib/audit/log';

export const dynamic = 'force-dynamic';
const MAX_POST_CHARS = 8000;

export async function POST(request: NextRequest) {
  if ((await getConfigValue('highlightsEnabled')) !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });

  let text = '';
  try {
    const body = await request.json();
    text = typeof body?.text === 'string' ? body.text.trim() : '';
  } catch { /* falls through to the empty-text 400 */ }
  if (text === '' || text.length > MAX_POST_CHARS) {
    return NextResponse.json({ error: `Post body must be 1–${MAX_POST_CHARS} characters` }, { status: 400 });
  }

  const webhookUrl = (await getConfigValue('digestSlackWebhookUrl')) || '';
  if (!webhookUrl) {
    return NextResponse.json({ error: 'No Slack webhook configured. Highlights sends via the Weekly Digest webhook (set it on this page under Weekly Digest).' }, { status: 400 });
  }

  const result = await postToSlackWebhook(webhookUrl, { text });
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, resource: 'highlights', action: 'WRITE', outcome: result.ok ? 'success' : 'failure', detail: result.ok ? 'post sent to Slack' : `send failed: ${result.error}` });
  if (!result.ok) {
    logError('api/admin/highlights/send', result.error ?? 'Slack post failed');
    return NextResponse.json({ error: 'Slack post failed: check the webhook URL. Details are in the server log.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

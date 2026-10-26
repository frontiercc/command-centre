// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { findAdminByEmail, createPasswordResetToken, hasActivatedAccountOnDomain, OTEL_PENDING_PASSWORD } from '@/lib/db/admin-queries';
import { isSmtpConfigured, sendPasswordResetEmail } from '@/lib/email/smtp';
import { isRateLimited } from '@/lib/auth/rate-limit';
import { logAuthEvent } from '@/lib/db/auth-events';
import { getConfigValue } from '@/lib/config';
import { isPlainEmail } from '@/lib/email/address';

export const dynamic = 'force-dynamic';

// The reset link is built only from an admin-configured public URL (the SSO
// redirect base, then the digest hub URL), never from a request header. The
// requester controls Origin and Host alike: with a Host fallback, a request
// carrying `Host: attacker.example` would make the genuine email link to the
// attacker's site, leaking the token, whenever the hub sat
// behind a proxy that forwards any host name (an AWS load balancer, the nginx
// example, or port 3001 reached directly). With no URL configured, no email is
// sent and the reason is recorded, so an admin can see what to set.
async function resetLinkOrigin(): Promise<string | null> {
  for (const key of ['ssoRedirectBaseUrl', 'digestHubUrl'] as const) {
    const configured = (await getConfigValue(key)).trim();
    if (!configured) continue;
    try {
      const u = new URL(configured);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    } catch { /* malformed — try the next source */ }
  }
  return null;
}

export async function POST(request: NextRequest) {
  // 5 attempts per 15 minutes per IP — prevents SMTP abuse
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
  if (isRateLimited(`forgot_password:${ip}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests. Please try again later.' },
      { status: 429 }
    );
  }

  let body: { email?: string };
  try {
    body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) {
    return NextResponse.json({ error: 'email_required' }, { status: 400 });
  }

  if (!(await isSmtpConfigured())) {
    return NextResponse.json({ smtpNotConfigured: true });
  }

  // Always return success to prevent email enumeration
  const user = await findAdminByEmail(email);
  if (user) {
    try {
      // Only a single plain address gets a link: a stored list such as
      // "a@evil.com,b@corp.com" would pass the domain check on its last part
      // and reach both inboxes.
      if (!isPlainEmail(user.email)) {
        await logAuthEvent({ eventType: 'password_reset_refused', details: JSON.stringify({ email: user.email, reason: 'not_a_plain_address' }) });
        return NextResponse.json({ ok: true });
      }
      // An auto-enrolled account's email and department come from telemetry,
      // and the collector token that sends telemetry sits on every monitored
      // machine, so anyone holding it can enrol an address of their choosing.
      // Such an account may activate itself only on an email domain where the
      // organisation already has an activated account, and never with a "+"
      // in the address: plus-addressing delivers bob+fin@corp.com to Bob's own
      // inbox, which would give Bob a second account in a department of his
      // choosing. Otherwise an admin sets the person up.
      if (user.password_hash === OTEL_PENDING_PASSWORD && user.email.split('@')[0].includes('+')) {
        await logAuthEvent({ eventType: 'password_reset_refused', details: JSON.stringify({ email: user.email, reason: 'auto_enrolled_plus_address' }) });
        return NextResponse.json({ ok: true });
      }
      if (user.password_hash === OTEL_PENDING_PASSWORD && !(await hasActivatedAccountOnDomain(user.email))) {
        await logAuthEvent({ eventType: 'password_reset_refused', details: JSON.stringify({ email: user.email, reason: 'auto_enrolled_unrecognised_domain' }) });
        return NextResponse.json({ ok: true });
      }
      const origin = await resetLinkOrigin();
      if (!origin) {
        console.error('[forgot-password] No public URL configured (SSO redirect base or digest hub URL); reset email not sent');
        await logAuthEvent({ eventType: 'password_reset_email_failed', details: JSON.stringify({ email: user.email, error: 'no_public_url_configured' }) });
        return NextResponse.json({ ok: true });
      }
      const rawToken = await createPasswordResetToken(user.id);
      const resetUrl = `${origin}/admin/reset-password/${rawToken}`;
      await sendPasswordResetEmail(user.email, resetUrl);
      await logAuthEvent({ eventType: 'password_reset_sent', details: JSON.stringify({ email: user.email }) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[forgot-password] Failed to send reset email:', msg);
      await logAuthEvent({ eventType: 'password_reset_email_failed', details: JSON.stringify({ email: user.email, error: msg }) });
    }
  }

  return NextResponse.json({ ok: true });
}

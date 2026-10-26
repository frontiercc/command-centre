// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Readiness-review fixes:
//  - the password-reset link is never built from the request's Origin header
//    (an attacker-set Origin would put a link to their site in a genuine email);
//    not from the Host header either (same attack behind a
//    proxy that forwards any host name), so with no public URL configured no
//    email is sent;
//  - an auto-enrolled account (email chosen by telemetry) may only activate
//    itself on a domain where the organisation already has an activated account.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const config: Record<string, string> = {};
const sendPasswordResetEmail = vi.fn();

vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(async (k: string) => config[k] ?? '') }));
vi.mock('@/lib/email/smtp', () => ({
  isSmtpConfigured: vi.fn(async () => true),
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
}));
let adminRow: { id: string; email: string; password_hash: string };
let domainActivated = true;
vi.mock('@/lib/db/admin-queries', () => ({
  OTEL_PENDING_PASSWORD: '__otel_pending__',
  findAdminByEmail: vi.fn(async () => adminRow),
  createPasswordResetToken: vi.fn(async () => 'tok123'),
  hasActivatedAccountOnDomain: vi.fn(async () => domainActivated),
}));
const logAuthEvent = vi.fn<(e: { eventType: string; details: string }) => Promise<void>>(async () => {});
vi.mock('@/lib/db/auth-events', () => ({ logAuthEvent: (e: { eventType: string; details: string }) => logAuthEvent(e) }));
vi.mock('@/lib/auth/rate-limit', () => ({ isRateLimited: () => false }));

const forgot = (headers: Record<string, string>) => new NextRequest('https://hub.example.com/api/admin/forgot-password', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ email: 'victim@example.com' }),
});

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  sendPasswordResetEmail.mockClear();
  logAuthEvent.mockClear();
  adminRow = { id: 'u1', email: 'victim@example.com', password_hash: 'scrypt$real' };
  domainActivated = true;
});

describe('forgot-password reset link', () => {
  const events = () => logAuthEvent.mock.calls.map(c => c[0].eventType);

  it('uses the configured public base URL, ignoring Origin and Host', async () => {
    config.ssoRedirectBaseUrl = 'https://ccc.customer.example/some/path';
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({ origin: 'https://evil.example.net', host: 'evil.example.net' }));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith('victim@example.com', 'https://ccc.customer.example/admin/reset-password/tok123');
  });

  it('uses the digest hub URL when no SSO base URL is set', async () => {
    config.digestHubUrl = 'https://digest.customer.example';
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({ origin: 'https://evil.example.net', host: 'evil.example.net' }));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith('victim@example.com', 'https://digest.customer.example/admin/reset-password/tok123');
  });

  it('with no public URL configured, sends no email, records why, and still answers ok', async () => {
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    const res = await POST(forgot({ host: 'evil.example.net', 'x-forwarded-proto': 'https' }));
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(events()).toEqual(['password_reset_email_failed']);
    expect(logAuthEvent.mock.calls[0][0].details).toContain('no_public_url_configured');
  });

  it('treats a malformed configured URL as unset', async () => {
    config.ssoRedirectBaseUrl = 'not a url';
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({ host: 'evil.example.net' }));
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('forgot-password for auto-enrolled accounts', () => {
  const events = () => logAuthEvent.mock.calls.map(c => c[0].eventType);
  beforeEach(() => {
    config.digestHubUrl = 'https://ccc.customer.example';
    adminRow = { id: 'u2', email: 'someone@gmail.example', password_hash: '__otel_pending__' };
  });

  it('refuses an auto-enrolled account on a domain with no activated account, with the same response', async () => {
    domainActivated = false;
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    const res = await POST(forgot({}));
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(events()).toEqual(['password_reset_refused']);
  });

  it('sends the link to an auto-enrolled account on a domain the organisation already uses', async () => {
    domainActivated = true;
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({}));
    expect(sendPasswordResetEmail).toHaveBeenCalledWith('someone@gmail.example', 'https://ccc.customer.example/admin/reset-password/tok123');
  });

  it('refuses a stored list address even when its last domain is in use', async () => {
    adminRow = { id: 'u4', email: 'attacker@example.net,someone@gmail.example', password_hash: '__otel_pending__' };
    domainActivated = true;
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    const res = await POST(forgot({}));
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(logAuthEvent.mock.calls.map(c => c[0].eventType)).toEqual(['password_reset_refused']);
    expect(logAuthEvent.mock.calls[0][0].details).toContain('not_a_plain_address');
  });

  it('refuses an auto-enrolled plus address even on a domain in use', async () => {
    adminRow = { id: 'u5', email: 'bob+fin@gmail.example', password_hash: '__otel_pending__' };
    domainActivated = true;
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    const res = await POST(forgot({}));
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(logAuthEvent.mock.calls[0][0].details).toContain('auto_enrolled_plus_address');
  });

  it('a plus address that already has a password still gets its link', async () => {
    adminRow = { id: 'u6', email: 'bob+work@elsewhere.example', password_hash: 'scrypt$real' };
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({}));
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('never applies the domain rule to an account that already has a password', async () => {
    adminRow = { id: 'u3', email: 'admin@elsewhere.example', password_hash: 'scrypt$real' };
    domainActivated = false;
    const { POST } = await import('@/app/api/admin/forgot-password/route');
    await POST(forgot({}));
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });
});

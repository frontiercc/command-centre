// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function getSafeRedirect(from: string | null): string {
  if (!from || !from.startsWith('/admin') || from.includes('://')) return '/admin/overview';
  return from;
}

const SSO_ERROR_MESSAGES: Record<string, string> = {
  email_unverified: 'Your identity provider did not verify this email address.',
  unknown_account: 'No Command Centre account exists for that email. Ask your administrator.',
  sso_not_enabled: "SSO isn't enabled for your account. Ask your administrator.",
  account_disabled: 'This account is disabled.',
  state_mismatch: 'Sign-in could not be completed. Please try again.',
  token_invalid: 'Sign-in could not be completed. Please try again.',
};

export default function AdminLoginPage() {
  return (
    <Suspense fallback={
      <div className="fixed inset-0 bg-[#F7F7F8] flex items-center justify-center z-50">
        <div className="w-5 h-5 border-2 border-[#0A0A0A] border-t-transparent rounded-full animate-spin" aria-label="Loading" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // Forgot password state
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotStatus, setForgotStatus] = useState<'idle' | 'sent' | 'not_configured'>('idle');

  // SSO state
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoLabel, setSsoLabel] = useState('SSO');
  const [ssoChecked, setSsoChecked] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  const ssoError = searchParams.get('sso_error');
  const ssoErrorMessage = ssoError ? SSO_ERROR_MESSAGES[ssoError] : undefined;

  useEffect(() => {
    fetch('/api/auth/sso/meta')
      .then(r => r.json())
      .then(data => {
        if (data?.enabled) {
          setSsoEnabled(true);
          setSsoLabel(data.label || 'SSO');
        }
      })
      .catch(() => {})
      .finally(() => setSsoChecked(true));
  }, []);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (data.setupNeeded) {
          router.replace('/admin/setup');
        } else if (data.authenticated) {
          router.replace(getSafeRedirect(from));
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [from, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe }),
      });

      const data = await res.json();

      if (res.ok) {
        if (data.mfaRequired) {
          setMfaRequired(true);
          setError('');
          return;
        }
        window.location.href = getSafeRedirect(from);
        return;
      } else {
        setError(data.message || data.error || 'Login failed. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMfaLoading(true);
    try {
      const res = await fetch('/api/admin/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: mfaCode }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = getSafeRedirect(from);
      } else {
        setError(data.message || 'Incorrect code. Please try again.');
        setMfaCode('');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      const res = await fetch('/api/admin/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json();
      if (data.smtpNotConfigured) {
        setForgotStatus('not_configured');
      } else {
        setForgotStatus('sent');
      }
    } catch {
      setForgotStatus('sent'); // Don't leak errors
    } finally {
      setForgotLoading(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#F7F7F8] flex flex-col items-center justify-center gap-6 p-4">
      <div className="w-full max-w-[380px] bg-white border border-[#EAEAEA] rounded-[16px] p-8 flex flex-col gap-5">
        {children}
      </div>
      <p className="m-0 text-[13px] text-[#8F8F8F]">Frontier Command Centre, created by Lee James</p>
    </div>
  );
  const brand = (heading: string, sub?: string) => (
    <div className="flex flex-col gap-3.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/frontier-logo-dark.svg" alt="Frontier Command Centre" className="h-[22px] w-auto self-start" />
      <div>
        <h1 className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-[#0A0A0A]">{heading}</h1>
        {sub && <p className="m-0 mt-1 text-[14px] text-[#666666]">{sub}</p>}
      </div>
    </div>
  );
  const inputCls = 'w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]';
  const primaryCls = 'w-full text-[14px] font-medium px-3.5 py-2.5 rounded-[10px] bg-[#0A0A0A] text-white hover:bg-[#262626] disabled:opacity-50 disabled:cursor-not-allowed';
  const linkCls = 'text-[13px] text-[#245BF3] hover:underline';

  if (checking) {
    return (
      <div className="fixed inset-0 z-50 bg-[#F7F7F8] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[#0A0A0A] border-t-transparent rounded-full animate-spin" aria-label="Loading" />
      </div>
    );
  }

  // ── MFA step ──────────────────────────────────────────────────────────────
  if (mfaRequired) {
    return shell(
      <>
        {brand('Two-factor authentication', 'Enter the code from your authenticator app')}
        <form onSubmit={handleMfaSubmit} className="flex flex-col gap-3.5 m-0">
          <label htmlFor="mfaCode" className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A]">
            Authenticator code
            <input
              id="mfaCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={`${inputCls} font-normal tracking-[0.3em] text-center`}
              placeholder="000000"
              maxLength={6}
            />
            <span className="text-[13px] font-normal text-[#8F8F8F]">The 6-digit code from your authenticator app, or a recovery code.</span>
          </label>
          <button type="submit" disabled={mfaLoading || mfaCode.length < 6} className={primaryCls}>
            {mfaLoading ? 'Verifying…' : 'Verify'}
          </button>
          {error && <p className="m-0 text-[14px] text-[#B42318]">{error}</p>}
          <button
            type="button"
            onClick={() => { setMfaRequired(false); setMfaCode(''); setError(''); }}
            className={`${linkCls} self-start`}
          >
            Back to sign in
          </button>
        </form>
      </>
    );
  }

  return shell(
    <>
      {brand('Sign in to Command Centre')}

      {/* SSO refusal banner */}
      {ssoErrorMessage && (
        <div className="border border-[#F5D9A8] bg-[#FFFAF0] rounded-[10px] px-3 py-2 text-[14px] text-[#5C3A00]">{ssoErrorMessage}</div>
      )}

      {/* SSO sign-in */}
      {ssoChecked && ssoEnabled && (
        <div className="flex flex-col gap-4">
          <a
            href="/api/auth/sso/start"
            className="w-full inline-flex items-center justify-center text-[14px] font-medium px-3.5 py-2.5 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] hover:bg-[#FAFAFA]"
          >
            Sign in with {ssoLabel}
          </a>
          {!showPasswordForm ? (
            <div className="flex items-center gap-3 text-[13px] text-[#8F8F8F]">
              <span className="h-px flex-1 bg-[#EAEAEA]" />
              <button type="button" onClick={() => setShowPasswordForm(true)} className={linkCls}>
                Sign in with password
              </button>
              <span className="h-px flex-1 bg-[#EAEAEA]" />
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[13px] text-[#8F8F8F]">
              <span className="h-px flex-1 bg-[#EAEAEA]" />or with your password<span className="h-px flex-1 bg-[#EAEAEA]" />
            </div>
          )}
        </div>
      )}

      {(!ssoChecked || !ssoEnabled || showPasswordForm) && (
        <>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5 m-0">
            <label htmlFor="email" className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A]">
              Email
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className={`${inputCls} font-normal`}
                placeholder="you@company.com"
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline">
                <label htmlFor="password" className="text-[14px] font-medium text-[#0A0A0A]">Password</label>
                <button
                  type="button"
                  onClick={() => { setShowForgot(true); setForgotStatus('idle'); setForgotEmail(''); }}
                  className={`${linkCls} ml-auto`}
                >
                  Forgot your password?
                </button>
              </div>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className={inputCls}
              />
            </div>

            <label htmlFor="rememberMe" className="flex items-center gap-2 text-[14px] text-[#4D4D4D] cursor-pointer select-none">
              <input
                id="rememberMe"
                type="checkbox"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                className="w-4 h-4 accent-[#0A0A0A] cursor-pointer"
              />
              Remember me
            </label>

            <button type="submit" disabled={loading} className={primaryCls}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>

            {error && <p className="m-0 text-[14px] text-[#B42318]">{error}</p>}
          </form>

          {/* Forgot password panel */}
          {showForgot && (
            <div className="pt-5 border-t border-[#EAEAEA] flex flex-col gap-3">
              {forgotStatus === 'sent' ? (
                <p className="m-0 text-[14px] text-[#146C2E]">If that email has an account, a reset link has been sent.</p>
              ) : forgotStatus === 'not_configured' ? (
                <p className="m-0 text-[14px] text-[#B54708]">Password reset email is not configured. Please contact an admin.</p>
              ) : (
                <form onSubmit={handleForgot} className="flex flex-col gap-3 m-0">
                  <label className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A]">
                    Reset your password
                    <span className="text-[13px] font-normal text-[#8F8F8F]">Enter your email to receive a reset link.</span>
                    <input
                      type="email"
                      required
                      value={forgotEmail}
                      onChange={e => setForgotEmail(e.target.value)}
                      placeholder="you@company.com"
                      className={`${inputCls} font-normal`}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={forgotLoading}
                    className="w-full text-[14px] font-medium px-3.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] hover:bg-[#FAFAFA] disabled:opacity-50"
                  >
                    {forgotLoading ? 'Sending…' : 'Send reset link'}
                  </button>
                </form>
              )}
              <button type="button" onClick={() => setShowForgot(false)} className={`${linkCls} self-start`}>
                Back to sign in
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

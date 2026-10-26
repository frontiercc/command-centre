// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

function getPasswordStrength(password: string): { label: string; color: string; barColor: string } {
  if (password.length === 0) return { label: '', color: '', barColor: '' };
  if (password.length < MIN_PASSWORD_LENGTH) return { label: 'Too short', color: 'text-[#B42318]', barColor: 'bg-red-500' };
  if (password.length < 16) return { label: 'Fair', color: 'text-[#B54708]', barColor: 'bg-yellow-500' };
  return { label: 'Strong', color: 'text-[#146C2E]', barColor: 'bg-green-500' };
}

function getPasswordBarWidth(password: string): string {
  if (password.length === 0) return 'w-0';
  if (password.length < MIN_PASSWORD_LENGTH) return 'w-1/3';
  if (password.length < 16) return 'w-2/3';
  return 'w-full';
}

export default function AdminSetupPage() {
  const router = useRouter();

  const [setupToken, setSetupToken] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.setupNeeded) {
          router.replace('/admin/login');
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [router]);

  const strength = getPasswordStrength(password);
  const barWidth = getPasswordBarWidth(password);

  function validate(): string | null {
    if (!setupToken.trim()) {
      return 'Enter the setup token from the server log.';
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return 'Please enter a valid email address.';
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `${PASSWORD_TOO_SHORT}.`;
    }
    if (password !== confirmPassword) {
      return 'Passwords do not match.';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupToken: setupToken.trim(),
          email,
          password,
          displayName: displayName.trim() || email.split('@')[0],
        }),
      });

      const data = await res.json();

      if (res.ok) {
        // Full page navigation (not client-side) to ensure the new session
        // cookie is sent with the request and middleware recognises it.
        // The Dashboard carries the Get started checklist.
        window.location.href = '/';
        return;
      } else {
        setError(data.message || data.error || 'Setup failed. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="fixed inset-0 bg-[#F7F7F8] flex items-center justify-center z-50">
        <div className="w-5 h-5 border-2 border-[#0A0A0A] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#F7F7F8] overflow-y-auto flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-[380px] bg-white rounded-[16px] border border-[#EAEAEA] p-8">
        {/* Brand header */}
        <div className="mb-6">
          <div className="flex items-center mb-3.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/frontier-logo.svg" alt="Frontier Command Centre" className="h-10 w-auto" />
          </div>
          <p className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-[#0A0A0A]">Command Centre</p>
          <p className="text-[#666666] text-[14px] mt-3">Create your admin account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* One-time setup token, printed in the server log at start-up */}
          <div>
            <label htmlFor="setupToken" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
              Setup token
            </label>
            <input
              id="setupToken"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              value={setupToken}
              onChange={e => setSetupToken(e.target.value)}
              className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3] font-mono"
              placeholder="From the server log"
            />
            <p className="text-[#8F8F8F] text-[13px] mt-1">Printed once in the hub&apos;s log when it starts. Restart the hub to get a new one.</p>
          </div>

          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
              placeholder="admin@example.com"
            />
          </div>

          {/* Display Name */}
          <div>
            <label htmlFor="displayName" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
              Display Name{' '}
              <span className="text-[#8F8F8F] font-normal">(optional)</span>
            </label>
            <input
              id="displayName"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
              placeholder="Defaults to email prefix"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
              placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
            />
            {/* Password strength indicator */}
            {password.length > 0 && (
              <div className="mt-2">
                <div className="h-1 w-full bg-[#F2F2F2] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${strength.barColor} ${barWidth}`}
                  />
                </div>
                <p className={`text-xs mt-1 ${strength.color}`}>{strength.label}</p>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label htmlFor="confirmPassword" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
              placeholder="••••••••"
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full text-[14px] font-medium px-3.5 py-2.5 rounded-[10px] bg-[#0A0A0A] text-white hover:bg-[#262626] disabled:opacity-50 disabled:cursor-not-allowed mt-1"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>

          {/* Error */}
          {error && (
            <p className="m-0 text-[14px] text-[#B42318]">{error}</p>
          )}
        </form>
      </div>
    </div>
  );
}

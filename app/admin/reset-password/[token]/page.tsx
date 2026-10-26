// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

export default function ResetPasswordPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`${PASSWORD_TOO_SHORT}.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setDone(true);
        setTimeout(() => router.replace('/admin/login'), 3000);
      } else {
        setError(data.message || 'This reset link is invalid or has expired.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-[#F7F7F8] overflow-y-auto flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-[380px] bg-white rounded-[16px] border border-[#EAEAEA] p-8">
        <div className="mb-6">
          <div className="flex items-center mb-3.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/frontier-logo-dark.svg" alt="Frontier Command Centre" className="h-[22px] w-auto" />
          </div>
          <p className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-[#0A0A0A]">Set new password</p>
        </div>

        {done ? (
          <div className="">
            <p className="m-0 mb-1 text-[14px] font-medium text-[#146C2E]">Password updated successfully.</p>
            <p className="text-[#8F8F8F] text-[13px]">Redirecting to sign in...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                autoFocus
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
                placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
              />
            </div>

            <div>
              <label htmlFor="confirm" className="block text-[14px] font-medium text-[#0A0A0A] mb-1.5">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className="w-full text-[14px] px-2.5 py-2 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full text-[14px] font-medium px-3.5 py-2.5 rounded-[10px] bg-[#0A0A0A] text-white hover:bg-[#262626] disabled:opacity-50 disabled:cursor-not-allowed mt-1"
            >
              {loading ? 'Updating...' : 'Set new password'}
            </button>

            {error && (
              <p className="m-0 text-[14px] text-[#B42318]">{error}</p>
            )}

            <div className="pt-1">
              <a href="/admin/login" className="text-[13px] text-[#245BF3] hover:underline">
                Back to sign in
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A captured TOTP code must not be reusable within its validity window —
// including against a DIFFERENT application instance from the one that first
// saw it. The consumed-timestep claim therefore lives in the database, not in
// per-process memory, or autoscaling reopens the replay window.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;
let totp: typeof import('@/lib/auth/totp');

beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  totp = await import('@/lib/auth/totp');
});

afterAll(async () => cleanup?.());

describe('TOTP replay guard', () => {
  it('accepts a valid code once, then rejects the replay for the same user', async () => {
    const secret = totp.generateTotpSecret();
    const code = totp.currentTotpCode(secret);
    expect(await totp.verifyAndConsumeTotp('user-A', code, secret)).toBe(true);   // first use
    expect(await totp.verifyAndConsumeTotp('user-A', code, secret)).toBe(false);  // replay rejected
  });

  it('rejects a code already consumed by a different application instance', async () => {
    const secret = totp.generateTotpSecret();
    const code = totp.currentTotpCode(secret);

    // Instance A sees the code first and consumes it.
    expect(await totp.verifyAndConsumeTotp('user-multi', code, secret)).toBe(true);

    // Instance B is a separate process with its own module state, sharing only
    // the database. Re-importing after a module reset stands in for that.
    vi.resetModules();
    const instanceB = await import('@/lib/auth/totp');
    expect(await instanceB.verifyAndConsumeTotp('user-multi', code, secret)).toBe(false);
  });

  it('tracks users independently (one user consuming a code does not block another)', async () => {
    const secret = totp.generateTotpSecret();
    const code = totp.currentTotpCode(secret);
    expect(await totp.verifyAndConsumeTotp('user-X', code, secret)).toBe(true);
    expect(await totp.verifyAndConsumeTotp('user-Y', code, secret)).toBe(true);
  });

  it('rejects an outright invalid code', async () => {
    const secret = totp.generateTotpSecret();
    expect(await totp.verifyAndConsumeTotp('user-Z', '000000', secret)).toBe(false);
  });

  it('verifyTotpCode (stateless, enrolment path) still validates a good code', () => {
    const secret = totp.generateTotpSecret();
    expect(totp.verifyTotpCode(totp.currentTotpCode(secret), secret)).toBe(true);
  });
});

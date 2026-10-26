// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the shared
// sealed-cookie primitive (lib/auth/totp.ts sealPendingPayload/
// unsealPendingPayload) used by both MFA (encryptMfaPending/decryptMfaPending)
// and SSO (lib/auth/oidc.ts). No DB required — this primitive is pure crypto
// over process.env.CCC_ENCRYPTION_KEY.
//
// Covers: round-trip for both purposes, expiry, tamper-evidence, CROSS-PURPOSE
// rejection in both directions (the bug this refactor fixes — proven pre-fix
// to reach findAdminById(undefined) -> 500 in /api/admin/mfa/verify when an
// SSO-sealed cookie was presented as an MFA cookie), legacy tag-less cookies
// (pre-domain-separation shape) failing closed, and the MFA wrapper's shape
// guard rejecting a payload missing userId.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  sealPendingPayload,
  unsealPendingPayload,
  encryptMfaPending,
  decryptMfaPending,
} from '@/lib/auth/totp';

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('sealPendingPayload / unsealPendingPayload — round-trip', () => {
  it('round-trips an mfa-purpose payload', () => {
    const sealed = sealPendingPayload('mfa', { userId: 'u1', rememberMe: true }, 60_000);
    const parsed = unsealPendingPayload<{ userId: string; rememberMe: boolean }>('mfa', sealed);
    expect(parsed).not.toBeNull();
    expect(parsed!.userId).toBe('u1');
    expect(parsed!.rememberMe).toBe(true);
  });

  it('round-trips an sso-purpose payload', () => {
    const sealed = sealPendingPayload('sso', { state: 's1', nonce: 'n1', verifier: 'v1' }, 60_000);
    const parsed = unsealPendingPayload<{ state: string; nonce: string; verifier: string }>('sso', sealed);
    expect(parsed).not.toBeNull();
    expect(parsed!.state).toBe('s1');
    expect(parsed!.nonce).toBe('n1');
    expect(parsed!.verifier).toBe('v1');
  });

  it('caller payload cannot override the embedded purpose or exp fields', () => {
    // Attempt to smuggle a conflicting purpose/exp inside the payload itself.
    const sealed = sealPendingPayload(
      'mfa',
      { userId: 'u1', purpose: 'sso', exp: 1 } as unknown as { userId: string },
      60_000,
    );
    // Still unseals correctly as 'mfa' (the real purpose wins) and is not
    // expired (the real exp, computed from ttlMs, wins).
    const asMfa = unsealPendingPayload<{ userId: string }>('mfa', sealed);
    expect(asMfa).not.toBeNull();
    expect(asMfa!.userId).toBe('u1');
    // And it must NOT unseal as 'sso' — the real embedded purpose is 'mfa'.
    const asSso = unsealPendingPayload('sso', sealed);
    expect(asSso).toBeNull();
  });
});

// ─── Expiry ─────────────────────────────────────────────────────────────────

describe('sealPendingPayload / unsealPendingPayload — expiry', () => {
  it('a negative TTL produces a token that is already expired', () => {
    const sealed = sealPendingPayload('mfa', { userId: 'u1' }, -1000);
    expect(unsealPendingPayload('mfa', sealed)).toBeNull();
  });
});

// ─── Tamper evidence ────────────────────────────────────────────────────────

describe('sealPendingPayload / unsealPendingPayload — tamper evidence', () => {
  it('flipping a character in the ciphertext breaks the auth tag and unseals to null', () => {
    const sealed = sealPendingPayload('mfa', { userId: 'u1' }, 60_000);
    const chars = sealed.split('');
    // Flip a character in the MIDDLE of the sealed string (inside the
    // iv/tag/ciphertext body, never the last char). The last base64url char
    // can be padding-only: when the underlying byte length mod 3 == 2, its
    // low 2 bits are unused, so ~6% of runs an A<->B flip there is a no-op
    // and the tamper silently fails to change the decoded bytes, flaking
    // this test. A middle index is always a full 6-bit unit. Swap between
    // 'A' (000000) and 'Q' (010000) — both valid base64url chars whose
    // high bits differ, guaranteeing the decoded byte actually changes.
    const idx = Math.min(40, chars.length - 2);
    chars[idx] = chars[idx] === 'A' ? 'Q' : 'A';
    const tampered = chars.join('');
    expect(unsealPendingPayload('mfa', tampered)).toBeNull();
  });

  it('garbage input unseals to null rather than throwing', () => {
    expect(unsealPendingPayload('mfa', 'not-a-real-sealed-token')).toBeNull();
    expect(unsealPendingPayload('sso', '')).toBeNull();
  });
});

// ─── Cross-purpose rejection (the core regression) ───────────────

describe('sealPendingPayload / unsealPendingPayload — cross-purpose rejection', () => {
  it('an sso-sealed cookie does NOT unseal as mfa', () => {
    const ssoSealed = sealPendingPayload('sso', { state: 's', nonce: 'n', verifier: 'v' }, 60_000);
    expect(unsealPendingPayload('mfa', ssoSealed)).toBeNull();
  });

  it('an mfa-sealed cookie does NOT unseal as sso', () => {
    const mfaSealed = sealPendingPayload('mfa', { userId: 'u1', rememberMe: false }, 60_000);
    expect(unsealPendingPayload('sso', mfaSealed)).toBeNull();
  });

  it('decryptMfaPending (the real MFA wrapper) rejects an SSO-purpose sealed cookie', () => {
    // Proves the originally-reported bug is closed end-to-end through the
    // actual MFA wrapper, not just the generic primitive: previously a
    // purpose-less SSO cookie unsealed as a truthy MFA payload and reached
    // findAdminById(undefined) -> 500 in /api/admin/mfa/verify.
    const ssoSealed = sealPendingPayload('sso', { state: 's', nonce: 'n', verifier: 'v' }, 60_000);
    expect(decryptMfaPending(ssoSealed)).toBeNull();
  });
});

// ─── Legacy tag-less construction fails closed ─────────────────────────────

describe('unsealPendingPayload — legacy (pre-domain-separation) cookies', () => {
  /**
   * Reimplements the exact pre-refactor sealPendingPayload construction:
   * AES-256-GCM, key = sha256(CCC_ENCRYPTION_KEY || dev fallback), 12-byte
   * random IV, base64url(iv || tag || ciphertext) over JSON.stringify of the
   * payload WITHOUT a `purpose` field (only `{...payload, exp}}`).
   */
  function legacySeal(payload: object, ttlMs: number): string {
    const raw = process.env.CCC_ENCRYPTION_KEY || 'dev-fallback-key-not-for-production';
    const key = crypto.createHash('sha256').update(raw).digest();
    const iv = crypto.randomBytes(12);
    const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
  }

  it('a tag-less legacy MFA-shaped cookie unseals to null under the new purpose-checked API', () => {
    const legacy = legacySeal({ userId: 'u1', rememberMe: true }, 60_000);
    expect(unsealPendingPayload('mfa', legacy)).toBeNull();
    expect(decryptMfaPending(legacy)).toBeNull();
  });

  it('a tag-less legacy SSO-shaped cookie unseals to null under the new purpose-checked API', () => {
    const legacy = legacySeal({ state: 's', nonce: 'n', verifier: 'v' }, 60_000);
    expect(unsealPendingPayload('sso', legacy)).toBeNull();
  });
});

// ─── MFA wrapper shape guard ────────────────────────────────────────────────

describe('decryptMfaPending — shape guard', () => {
  it('accepts a well-formed payload', () => {
    const sealed = encryptMfaPending('user-123', false);
    const parsed = decryptMfaPending(sealed);
    expect(parsed).toEqual({ userId: 'user-123', rememberMe: false });
  });

  it('rejects a payload missing userId (typeof guard), even though it is a validly-sealed mfa cookie', () => {
    const sealed = sealPendingPayload('mfa', { rememberMe: true } as unknown as { userId: string; rememberMe: boolean }, 60_000);
    expect(decryptMfaPending(sealed)).toBeNull();
  });

  it('rejects a payload where userId is not a string', () => {
    const sealed = sealPendingPayload('mfa', { userId: 12345, rememberMe: true } as unknown as { userId: string; rememberMe: boolean }, 60_000);
    expect(decryptMfaPending(sealed)).toBeNull();
  });
});

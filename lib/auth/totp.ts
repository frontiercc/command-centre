// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

// ─── TOTP — pure Node.js crypto, no external library ─────────────────────
// RFC 6238 / RFC 4226 compliant. Compatible with Google Authenticator.

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const str = input.toUpperCase().replace(/=+$/, '');
  const output: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of str) {
    const val = BASE32_CHARS.indexOf(char);
    if (val < 0) continue;
    buffer = ((buffer << 5) | val) & 0xffffff; // cap at 24 bits — safe from 32-bit overflow
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      output.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return Buffer.from(output);
}

function generateHotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function generateTotpSecret(): string {
  // 20 random bytes → base32 (160-bit secret, Google Authenticator compatible)
  const bytes = crypto.randomBytes(20);
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  return result;
}

export function getTotpUri(email: string, secret: string): string {
  const label = encodeURIComponent(`Frontier Command Centre:${email}`);
  const issuer = encodeURIComponent('Frontier Command Centre');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

/** Returns the matched timestep (counter) if the code is valid, else null. */
export function matchTotpStep(code: string, secret: string): number | null {
  const counter = Math.floor(Date.now() / 1000 / 30);
  // Check current window and ±1 step (allows 30s clock skew)
  for (const delta of [-1, 0, 1]) {
    if (generateHotp(secret, counter + delta) === code) return counter + delta;
  }
  return null;
}

/** Stateless validity check (used by MFA enrolment). Does NOT consume the code. */
export function verifyTotpCode(code: string, secret: string): boolean {
  return matchTotpStep(code, secret) !== null;
}

/** The valid code for the current timestep — used by tests and previews. */
export function currentTotpCode(secret: string): string {
  return generateHotp(secret, Math.floor(Date.now() / 1000 / 30));
}

// ─── TOTP replay guard ──────────────────────────────────────────────────────
// A valid 6-digit code stays valid for its ~30–90s window, so without tracking
// it could be replayed by anyone who captures it inside that window. We record
// the highest timestep each user has consumed and reject any code whose timestep
// is not strictly newer.
//
// This state lives in the DATABASE, not in per-process memory (migration 078).
// In-memory was safe only while exactly one application instance ran: a second
// instance has its own empty map, so a captured code replayed against it inside
// the same window was accepted — a real MFA bypass the moment the compute tier
// autoscales. The database is the one thing every instance shares.
//
// The check and the claim are a SINGLE atomic upsert, not a read-then-write:
// two instances racing the same code must not both conclude they won. The row
// is written only when the incoming timestep is strictly newer than the stored
// one, and `.returning()` is empty when it wasn't — that emptiness IS the
// rejection, decided by the database rather than by application logic.

/**
 * Verify a LOGIN TOTP code and consume it, rejecting replays. Returns true only
 * if the code is valid AND its timestep is newer than the last one this user
 * consumed — on ANY instance. Reusing the same code (same timestep) or an older
 * one returns false.
 */
export async function verifyAndConsumeTotp(userId: string, code: string, secret: string): Promise<boolean> {
  const step = matchTotpStep(code, secret);
  if (step === null) return false;

  // Imported lazily so the pure TOTP helpers above stay usable (and testable)
  // without pulling in a database client.
  const { getTypedClient } = await import('@/lib/db/client');
  const { default: schema } = await import('@/lib/db/schema');
  const { sql } = await import('drizzle-orm');

  const db = await getTypedClient();
  const t = schema.totpConsumedSteps;
  const claimed = await db
    .insert(t)
    .values({ user_id: userId, step, consumed_at: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({
      target: t.user_id,
      set: { step: sql`excluded.step`, consumed_at: sql`excluded.consumed_at` },
      setWhere: sql`${t.step} < excluded.step`,
    })
    .returning();

  return claimed.length > 0;
}

// ─── Recovery codes ───────────────────────────────────────────────────────

const RECOVERY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(10);
  const part = (start: number) =>
    Array.from({ length: 5 }, (_, i) => RECOVERY_CODE_CHARS[bytes[start + i] % RECOVERY_CODE_CHARS.length]).join('');
  return `${part(0)}-${part(5)}`;
}

export function generateRecoveryCodes(count = 10): { raw: string[]; hashed: string[] } {
  const raw: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateRecoveryCode();
    raw.push(code);
    // Hashed exactly as sign-in hashes the entered code (hyphen and spaces
    // removed, upper case). Hashing it with its hyphen would mean no
    // recovery code ever matched.
    hashed.push(hashRecoveryCode(code));
  }
  return { raw, hashed };
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
}

// ─── Pending-cookie sealing (short-lived encrypted token, generic) ────────
//
// Shared primitive for any short-lived, tamper-evident, encrypted cookie
// payload with a self-contained expiry: MFA's pending-2FA token below, and
// OIDC SSO's pending {state, nonce, verifier} token (lib/auth/oidc.ts). Same
// AES-256-GCM construction, same key derivation, same base64url envelope —
// only the JSON payload shape and TTL differ per caller.
//
// Domain separation: every sealed payload embeds a `purpose` tag INSIDE the
// AEAD-protected JSON (not just AES-GCM's tamper-evidence — GCM proves the
// bytes weren't altered, it does NOT stop a validly-sealed cookie from one
// domain being replayed as another domain's cookie, since both are sealed
// under the same key). `unsealPendingPayload` refuses to return a payload
// unless the embedded purpose matches what the caller expects. This closes a
// cross-purpose confusion: an SSO pending cookie must never unseal as a
// truthy MFA payload (or vice versa). There is deliberately NO legacy
// acceptance path — tag-less cookies from before this change unseal to null
// (fail closed). Any such cookie is a 5-10 minute TTL token, so in-flight
// ones at deploy time simply die harmlessly and the user restarts the flow.

export type PendingPurpose = 'mfa' | 'sso';

function getPendingCookieKey(): Buffer {
  const raw = process.env.CCC_ENCRYPTION_KEY || 'dev-fallback-key-not-for-production';
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Seal an arbitrary JSON-serializable payload into an encrypted, base64url
 * token good for `ttlMs`, tagged with `purpose`. Spread order places the
 * caller's payload FIRST so it cannot override the `purpose` or `exp` fields
 * that are always the ones actually sealed.
 */
export function sealPendingPayload<T extends object>(purpose: PendingPurpose, payload: T, ttlMs: number): string {
  const key = getPendingCookieKey();
  const iv = crypto.randomBytes(12);
  const body = JSON.stringify({ ...payload, purpose, exp: Date.now() + ttlMs });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * Unseal a token produced by `sealPendingPayload`. Returns null on tamper,
 * corruption, expiry, or if the embedded `purpose` does not match `purpose`.
 * Tag-less (pre-domain-separation) tokens always fail this — there is no
 * legacy-acceptance branch, by design (fail closed).
 */
export function unsealPendingPayload<T>(purpose: PendingPurpose, token: string): (T & { exp: number }) | null {
  try {
    const key = getPendingCookieKey();
    const buf = Buffer.from(token, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    if (parsed.purpose !== purpose) return null;
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
    return parsed as T & { exp: number };
  } catch {
    return null;
  }
}

// ─── MFA pending cookie ────────────────────────────────────────────────────

export const MFA_PENDING_COOKIE = 'ccc_mfa_pending';
const MFA_PENDING_TTL_MS = 5 * 60 * 1000;

export function encryptMfaPending(userId: string, rememberMe: boolean): string {
  return sealPendingPayload('mfa', { userId, rememberMe }, MFA_PENDING_TTL_MS);
}

export function decryptMfaPending(token: string): { userId: string; rememberMe: boolean } | null {
  const parsed = unsealPendingPayload<{ userId: string; rememberMe: boolean }>('mfa', token);
  if (!parsed) return null;
  if (typeof parsed.userId !== 'string') return null;
  return { userId: parsed.userId, rememberMe: Boolean(parsed.rememberMe) };
}

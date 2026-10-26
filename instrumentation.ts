// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

let schedulerStarted = false;

// Known default / placeholder encryption keys that must never protect real data.
// Booting under any of these means every at-rest secret and every sealed MFA/SSO
// cookie is encrypted under a publicly-known key. The compose default used to be
// baked in (so the key was never actually "unset" and the old check never fired);
// it has been removed, and the totp.ts dev fallback is listed here too so setting
// the key to that literal is also refused in production.
const KNOWN_DEFAULT_KEYS = new Set([
  'dev-fallback-key-not-for-production',          // lib/auth/totp.ts getPendingCookieKey fallback
  'change-me',
]);

export interface EncryptionKeyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Pure, testable encryption-key policy. In production the key MUST be present
 * and MUST NOT be a known default/placeholder. Outside production a missing or
 * default key is tolerated (dev fallback) but noisy.
 */
export function checkEncryptionKey(key: string | undefined, nodeEnv: string | undefined): EncryptionKeyCheck {
  const isProd = nodeEnv === 'production';
  if (!key) {
    return isProd ? { ok: false, reason: 'CCC_ENCRYPTION_KEY is not set' } : { ok: true };
  }
  if (KNOWN_DEFAULT_KEYS.has(key)) {
    return isProd
      ? { ok: false, reason: 'CCC_ENCRYPTION_KEY is a known default/placeholder value' }
      : { ok: true };
  }
  return { ok: true };
}

export interface CookiePolicyCheck {
  ok: boolean;
  /** Set when insecure cookies are explicitly allowed in production: log it loudly. */
  warning?: string;
  reason?: string;
}

/**
 * Pure, testable session-cookie policy.
 * In production, dropping the Secure flag needs BOTH CCC_INSECURE_COOKIES=true
 * and the explicit override CCC_ALLOW_INSECURE_COOKIES=true. One flag alone
 * refuses to start.
 * Outside production the flag is harmless (cookies are not Secure there anyway).
 */
export function checkCookiePolicy(insecure: string | undefined, allow: string | undefined, nodeEnv: string | undefined): CookiePolicyCheck {
  if (nodeEnv !== 'production' || insecure !== 'true') return { ok: true };
  if (allow === 'true') {
    return { ok: true, warning: 'Session cookies are NOT Secure (CCC_INSECURE_COOKIES=true, explicitly allowed by CCC_ALLOW_INSECURE_COOKIES=true). Only acceptable on localhost or before TLS is in front of the hub.' };
  }
  return {
    ok: false,
    reason: 'CCC_INSECURE_COOKIES=true in production without CCC_ALLOW_INSECURE_COOKIES=true. Remove CCC_INSECURE_COOKIES once the hub is served over HTTPS, or set both for localhost / a pre-TLS install',
  };
}

// Scheduled jobs must run in exactly ONE place. Every Node process would start
// the scheduler otherwise, which is right for a single instance and wrong once
// the compute tier autoscales.
//
// On Postgres the instances elect a leader through an advisory lock
// (lib/db/scheduler-lock.ts): the holder runs the scheduler, the others retry,
// and a live instance takes over when the holder's connection dies. A single
// instance wins at boot, so no deployment needs a setting for today's
// behaviour. An earlier CCC_SCHEDULER env var is gone: ECS Fargate and Azure
// Container Apps give every replica of a service one environment block, so
// "some replicas on, some off" could not be expressed on an autoscaled service.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && !schedulerStarted) {
    schedulerStarted = true;
    validateConfig();
    // Encrypt any sensitive config value still stored as
    // plaintext. Idempotent and safe on every instance at once; never blocks boot.
    try {
      const { encryptStoredSecrets } = await import('./lib/config');
      const { encrypted } = await encryptStoredSecrets();
      if (encrypted > 0) console.log(`[CCC] ✓ Encrypted ${encrypted} stored secret(s) at rest.`);
    } catch (err) {
      console.error('[CCC] Could not encrypt stored secrets at boot (they stay readable):', err instanceof Error ? err.message : err);
    }
    // MFA seed encryption, release 2: convert any seed still stored
    // as plaintext. Same rules as above: idempotent, never blocks boot.
    try {
      const { encryptStoredTotpSeeds } = await import('./lib/db/admin-queries');
      const { encrypted } = await encryptStoredTotpSeeds();
      if (encrypted > 0) console.log(`[CCC] ✓ Encrypted ${encrypted} MFA seed(s) at rest.`);
    } catch (err) {
      console.error('[CCC] Could not encrypt MFA seeds at boot (they stay readable):', err instanceof Error ? err.message : err);
    }
    // First-admin setup token: only while no admin
    // exists. Printed once here; only its hash is stored. Never blocks boot.
    try {
      const { issueSetupTokenIfNeeded } = await import('./lib/auth/setup-token');
      const { adminUserCount } = await import('./lib/db/admin-queries');
      const r = await issueSetupTokenIfNeeded(adminUserCount);
      if (r.status === 'issued') {
        console.warn('[CCC] ================================================================');
        console.warn('[CCC] No admin account exists yet. To create one, open /admin/setup');
        console.warn(`[CCC] and enter this one-time setup token: ${r.token}`);
        console.warn('[CCC] It works once. Restart the hub to issue a new one.');
        console.warn('[CCC] ================================================================');
      } else if (r.status === 'already_issued') {
        console.warn('[CCC] No admin account exists yet. A setup token was already printed in the last 10 minutes. Look for it earlier in this log. If you cannot find it, wait 10 minutes and run docker compose restart hub for a new one.');
      }
    } catch (err) {
      console.error('[CCC] Could not issue a first-admin setup token:', err instanceof Error ? err.message : err);
    }
    const { startScheduler, stopScheduler } = await import('./lib/ingestion/scheduler');

    const { startLeaderElection } = await import('./lib/db/scheduler-lock');
    const { pgConnectionConfig } = await import('./lib/db/client');
    const { Client } = await import('pg');
    const election = startLeaderElection({
      // A DEDICATED connection, never one from the app pool: the lock is held
      // for the process lifetime. keepAlive is cheap hygiene — pg leaves the
      // keepalive initial delay at 0, so detection falls to the OS default
      // (~2h on Linux); it's the 30s SELECT 1 heartbeat in scheduler-lock.ts
      // that actually detects a dead socket.
      createClient: () => new Client({ ...pgConnectionConfig(), keepAlive: true }),
      onElected: startScheduler,
      onDemoted: stopScheduler,
    });
    console.log('[Instrumentation] Scheduler leader election started; one instance will run the scheduled jobs');

    // Best-effort release on graceful shutdown. The connection closing releases
    // the lock anyway; this just makes the handover immediate. No process.exit
    // here: Next's own shutdown carries on.
    const shutdown = () => {
      election.stop().catch(() => {});
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}

function validateConfig() {
  const warnings: string[] = [];

  // HARD GATE — refuse to boot in production under a missing or known-default
  // encryption key. This runs before the scheduler starts serving anything.
  const keyCheck = checkEncryptionKey(process.env.CCC_ENCRYPTION_KEY, process.env.NODE_ENV);
  if (!keyCheck.ok) {
    console.error(
      `[CCC] ✖ FATAL: ${keyCheck.reason}. Set a unique, secret CCC_ENCRYPTION_KEY in the environment. Refusing to start.`,
    );
    process.exit(1);
  }
  if (!process.env.CCC_ENCRYPTION_KEY) {
    warnings.push('CCC_ENCRYPTION_KEY is not set — using a dev fallback. NEVER run production like this.');
  } else {
    console.log('[CCC] ✓ CCC_ENCRYPTION_KEY is set to a non-default value.');
  }

  if (!process.env.ANTHROPIC_AI_API_KEY) {
    warnings.push('ANTHROPIC_AI_API_KEY is not set in the environment — fine if the key is saved on /admin/security; otherwise AI features are unavailable.');
  }

  // HARD GATE — insecure session cookies in production need an explicit override.
  const cookieCheck = checkCookiePolicy(process.env.CCC_INSECURE_COOKIES, process.env.CCC_ALLOW_INSECURE_COOKIES, process.env.NODE_ENV);
  if (!cookieCheck.ok) {
    console.error(`[CCC] ✖ FATAL: ${cookieCheck.reason}. Refusing to start.`);
    process.exit(1);
  }
  if (cookieCheck.warning) warnings.push(cookieCheck.warning);

  for (const msg of warnings) console.warn(`[CCC] ⚠ WARNING: ${msg}`);
}

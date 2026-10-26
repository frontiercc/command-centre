// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OIDC SSO core — discovery, PKCE authorization-code flow, sealed pending
// state, and the authorization gate against admin_users.
//
// AuthN vs AuthZ split: the IdP proves identity ONLY (email + email_verified,
// or Entra's xms_edov; see isEmailVerified).
// Authorization is entirely local — a pre-provisioned admin_users row with
// sso_enabled=1. There is no JIT provisioning in v1: an unknown email is a
// polite refusal, never an account creation.
import * as client from 'openid-client';
import { getAllConfig } from '@/lib/config';
import { findAdminByEmail, type AdminUserRow } from '@/lib/db/admin-queries';
import { sealPendingPayload, unsealPendingPayload } from '@/lib/auth/totp';

// ─── Settings ───────────────────────────────────────────────────────────────

export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  providerLabel: string;
}

/**
 * Reads the six ssoXxx config keys and returns a fully-resolved settings
 * object, or null if SSO isn't usable yet: `ssoEnabled` must be the literal
 * string 'true' (via getAllConfig's boolean coercion) AND issuer, clientId,
 * clientSecret, and redirectBase must all be non-empty. Any single missing
 * piece means SSO is not configured — never a partial/broken settings object.
 */
export async function getOidcSettings(): Promise<OidcSettings | null> {
  const cfg = await getAllConfig();
  if (!cfg.ssoEnabled) return null;
  if (!cfg.ssoIssuerUrl || !cfg.ssoClientId || !cfg.ssoClientSecret || !cfg.ssoRedirectBaseUrl) return null;

  const redirectUri = new URL('/api/auth/sso/callback', cfg.ssoRedirectBaseUrl).toString();

  return {
    issuerUrl: cfg.ssoIssuerUrl,
    clientId: cfg.ssoClientId,
    clientSecret: cfg.ssoClientSecret,
    redirectUri,
    providerLabel: cfg.ssoProviderLabel,
  };
}

// ─── Discovery cache ────────────────────────────────────────────────────────
//
// Module-level cache keyed by the settings that actually determine the
// discovered Configuration (issuer/clientId/clientSecret) so an admin editing
// SSO config mid-process is picked up on the next call without a restart.
// Any discovery OR token-exchange failure invalidates the cache immediately
// (rather than waiting out the TTL) so a config fix takes effect right away.

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // ~1h

let discoveryCache: {
  key: string;
  config: client.Configuration;
  cachedAt: number;
} | null = null;

function discoveryCacheKey(settings: OidcSettings): string {
  return `${settings.issuerUrl}::${settings.clientId}::${settings.clientSecret}`;
}

function invalidateDiscoveryCache(): void {
  discoveryCache = null;
}

async function discover(settings: OidcSettings): Promise<client.Configuration> {
  const key = discoveryCacheKey(settings);
  const now = Date.now();
  if (discoveryCache && discoveryCache.key === key && now - discoveryCache.cachedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.config;
  }

  const issuer = new URL(settings.issuerUrl);
  const execute = issuer.protocol === 'http:' ? [client.allowInsecureRequests] : undefined;

  try {
    const config = await client.discovery(
      issuer,
      settings.clientId,
      settings.clientSecret,
      undefined,
      execute ? { execute } : undefined,
    );
    discoveryCache = { key, config, cachedAt: now };
    return config;
  } catch (err) {
    invalidateDiscoveryCache();
    throw err;
  }
}

// ─── Test connection (admin "Test connection" button) ──────────────────────

export interface OidcDiscoveryTestResult {
  ok: boolean;
  issuer?: string;
  error?: string;
}

/**
 * Runs OIDC discovery against the CURRENTLY SAVED settings (or, when
 * provided, an in-flight override — the admin card tests before saving) and
 * reports the outcome. Never echoes the client secret back; on success only
 * the discovered issuer identifier is returned, on failure only a short
 * error message. Does not touch the shared discovery cache's TTL semantics
 * beyond what `discover()` already does (a fresh admin-triggered test that
 * fails still invalidates the cache, same as a real login attempt would).
 */
export async function testOidcDiscovery(override?: Partial<OidcSettings>): Promise<OidcDiscoveryTestResult> {
  const saved = await getOidcSettings();
  const settings: OidcSettings | null = override
    ? {
        issuerUrl: override.issuerUrl ?? saved?.issuerUrl ?? '',
        clientId: override.clientId ?? saved?.clientId ?? '',
        clientSecret: override.clientSecret ?? saved?.clientSecret ?? '',
        redirectUri: override.redirectUri ?? saved?.redirectUri ?? '',
        providerLabel: override.providerLabel ?? saved?.providerLabel ?? 'SSO',
      }
    : saved;
  if (!settings || !settings.issuerUrl || !settings.clientId || !settings.clientSecret) {
    return { ok: false, error: 'SSO is not configured. Set issuer URL, client ID, and client secret first' };
  }

  try {
    const config = await discover(settings);
    const issuer = config.serverMetadata().issuer;
    return { ok: true, issuer };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Discovery failed' };
  }
}

// ─── Pending cookie (sealed PKCE + state + nonce) ──────────────────────────

/** Cookie name for the sealed SSO pending payload — same class as MFA_PENDING_COOKIE. */
export const SSO_PENDING_COOKIE = 'ccc_sso_pending';
const SSO_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface SsoPendingPayload {
  state: string;
  nonce: string;
  verifier: string;
}

// ─── beginSsoLogin ──────────────────────────────────────────────────────────

export interface SsoStart {
  redirectUrl: string;
  pendingCookie: string; // sealed {state, nonce, verifier, exp}
}

export async function beginSsoLogin(): Promise<SsoStart> {
  const settings = await getOidcSettings();
  if (!settings) {
    throw new Error('SSO is not configured');
  }

  const config = await discover(settings);

  const verifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const authUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  const pendingCookie = sealPendingPayload<SsoPendingPayload>('sso', { state, nonce, verifier }, SSO_PENDING_TTL_MS);

  return { redirectUrl: authUrl.toString(), pendingCookie };
}

// ─── completeSsoLogin ───────────────────────────────────────────────────────

export type SsoRefusal =
  | 'email_unverified'
  | 'unknown_account'
  | 'sso_not_enabled'
  | 'account_disabled'
  | 'state_mismatch'
  | 'token_invalid';

/**
 * Whether the identity provider vouches for the email claim. Google, Okta and
 * most providers send email_verified: true. Microsoft Entra ID does not send
 * email_verified; its equivalent is the optional claim xms_edov ("email domain
 * owner verified"), which an Entra admin adds to the app registration's ID
 * token. An explicit email_verified other than true always refuses, whatever
 * else the token carries.
 */
export function isEmailVerified(claims: Record<string, unknown>): boolean {
  if (claims.email_verified === true) return true;
  if (claims.email_verified !== undefined) return false;
  // xms_edov is Microsoft's claim, so it counts only on a token Microsoft issued.
  if (!isMicrosoftIssuer(claims.iss)) return false;
  const edov = claims.xms_edov;
  return edov === true || edov === 'true' || edov === 1 || edov === '1';
}

/** Microsoft Entra ID issuers: the public cloud and the sovereign clouds. */
const MICROSOFT_ISSUER = /^https:\/\/(login\.microsoftonline\.(com|us)|login\.partner\.microsoftonline\.cn|sts\.windows\.net)\//;

function isMicrosoftIssuer(iss: unknown): boolean {
  return typeof iss === 'string' && MICROSOFT_ISSUER.test(iss);
}

export type SsoResult =
  | { ok: true; account: { id: string; email: string; role: string } }
  | { ok: false; reason: SsoRefusal };

function refuse(reason: SsoRefusal): SsoResult {
  return { ok: false, reason };
}

/**
 * Authorization gate, BINDING order:
 *   1. the email is verified by the IdP (isEmailVerified)
 *   2. account exists (lowercased email vs admin_users.email)
 *   3. sso_enabled = 1
 *   4. not deactivated
 *
 * Step 4 is a no-op today: admin_users has NO deactivation column. Migration
 * 036 added `deactivated_at` to the `users` table (monitored/Pulse-surface
 * users), a different table entirely from `admin_users` (login accounts).
 * `admin_users.locked_until` (migration 052) is also a distinct concept — a
 * temporary auto-expiring login-throttle lock, not deliberate deactivation —
 * and is intentionally NOT treated as "disabled" here. If/when admin_users
 * gains a real deactivation column, step 4 should check it and return
 * 'account_disabled'; until then this gate is existence + sso_enabled only.
 */
function checkAuthorizationGate(account: AdminUserRow): SsoResult | null {
  if (account.sso_enabled !== 1) return refuse('sso_not_enabled');
  // Step 4 (not deactivated): no-op — see function doc comment.
  return null;
}

export async function completeSsoLogin(
  callbackUrl: URL,
  pendingCookie: string | undefined,
): Promise<SsoResult> {
  if (!pendingCookie) return refuse('state_mismatch');

  const pending = unsealPendingPayload<SsoPendingPayload>('sso', pendingCookie);
  if (!pending) return refuse('state_mismatch');
  if (
    typeof pending.state !== 'string' ||
    typeof pending.nonce !== 'string' ||
    typeof pending.verifier !== 'string'
  ) {
    return refuse('state_mismatch');
  }

  const callbackState = callbackUrl.searchParams.get('state');
  if (!callbackState || callbackState !== pending.state) return refuse('state_mismatch');

  const settings = await getOidcSettings();
  if (!settings) return refuse('state_mismatch');

  let config: client.Configuration;
  try {
    config = await discover(settings);
  } catch {
    return refuse('token_invalid');
  }

  let claims: Record<string, unknown> | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
    });
    claims = tokens.claims();
  } catch {
    // Covers: state/nonce validation failures thrown by openid-client itself,
    // token exchange errors (incl. a replayed/already-consumed authorization
    // code — invalid_grant from the IdP), signature/aud/exp validation
    // failures. Any of these invalidate the discovery cache so a stale/broken
    // config doesn't keep failing silently past a fix.
    invalidateDiscoveryCache();
    return refuse('token_invalid');
  }

  if (!claims) return refuse('token_invalid');

  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const emailVerified = isEmailVerified(claims);

  // Gate 1: email_verified required — never trust an unverified email claim
  // to match an account, regardless of what the account lookup would find.
  if (!email || !emailVerified) return refuse('email_unverified');

  // Gate 2: account exists (lowercased email).
  const account = await findAdminByEmail(email.toLowerCase());
  if (!account) return refuse('unknown_account');

  // Gates 3-4.
  const gateRefusal = checkAuthorizationGate(account);
  if (gateRefusal) return gateRefusal;

  return {
    ok: true,
    account: { id: account.id, email: account.email, role: account.role },
  };
}

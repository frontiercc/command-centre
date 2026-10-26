// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import { timingSafeCompare } from '@/lib/auth/tokens';
import { logAuthEvent } from '@/lib/db/auth-events';
import { getConfigValue } from '@/lib/config';

// NOTE: This module must only be imported in Node.js runtime contexts
// (API routes, server components), never from Edge Runtime / middleware.

// ─── Types ────────────────────────────────────────────────────────────────

export interface IngestAuthResult {
  authenticated: boolean;
  /** 'collector' for the collector token, 'legacy' for the shared secret
   *  (the rate-limit key and the stored agent_id), null otherwise. */
  agentId: string | null;
  isCollector?: boolean;
  error?: string;
  httpStatus?: number;
}

/**
 * When NO shared ingest secret is configured, ingest used to "allow through"
 * unconditionally (a local-dev convenience that also left any secret-less
 * production instance wide open). Fail CLOSED in production; keep the open
 * behaviour only in non-production (which includes the test suite).
 * CCC_DEV_BYPASS_AUTH is deliberately IGNORED in production: a developer
 * flag left set in production must never open ingest.
 */
export function legacyNoSecretAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ─── Main auth function ───────────────────────────────────────────────────

/**
 * Authenticate an incoming telemetry ingest request.
 *
 * Supports two paths, both as `Authorization: Bearer <token>`:
 * 1. The collector token (`CCC_COLLECTOR_TOKEN`).
 * 2. The shared secret, compared timing-safe against the configured
 *    `otelEndpointSecret` (DB or env `OTEL_ENDPOINT_SECRET`). When no secret
 *    is configured the request is allowed through only outside production.
 */
export async function authenticateIngest(request: NextRequest): Promise<IngestAuthResult> {
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  // ── Collector token path ────────────────────────────────────────────────
  const collectorToken = process.env.CCC_COLLECTOR_TOKEN;
  if (collectorToken && bearerToken && timingSafeCompare(bearerToken, collectorToken)) {
    return { authenticated: true, agentId: 'collector', isCollector: true };
  }

  // ── Shared secret path ──────────────────────────────────────────────────
  const configuredSecret =
    (await getConfigValue('otelEndpointSecret')) || process.env.OTEL_ENDPOINT_SECRET || '';

  // No secret configured. Fail CLOSED in production (an unset ingest secret must
  // not mean "accept telemetry from anyone"); allow only in non-production.
  if (!configuredSecret) {
    if (legacyNoSecretAllowed()) {
      return { authenticated: true, agentId: null };
    }
    return {
      authenticated: false,
      agentId: null,
      error: 'Unauthorized: ingest authentication is not configured',
      httpStatus: 401,
    };
  }

  if (bearerToken && timingSafeCompare(bearerToken, configuredSecret)) {
    return { authenticated: true, agentId: 'legacy' };
  }

  // No match
  await logAuthEvent({ eventType: 'auth_failed', details: 'Invalid shared secret' });
  return {
    authenticated: false,
    agentId: null,
    error: 'Unauthorized: invalid OTel endpoint secret',
    httpStatus: 401,
  };
}

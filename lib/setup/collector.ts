// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The collector's address and bearer token, so an admin can connect Claude from
 * Admin → Ingestion and the Get started panel without opening .env.
 *
 * Docker Compose passes the bearer token (OTEL_ENDPOINT_SECRET) to the Hub as
 * CCC_CLIENT_BEARER_TOKEN, a display-only name: the Hub never accepts
 * it as a credential (lib/auth/ingest-auth.ts checks CCC_COLLECTOR_TOKEN and
 * OTEL_ENDPOINT_SECRET only), so telemetry still has to go through the
 * collector. Callers must be admin-only routes.
 *
 * The address an admin saves on Admin → Ingestion (config key
 * otelCollectorAddress) wins, then CCC_COLLECTOR_ADDRESS, then the local
 * default. No server imports, so the panel can use normaliseCollectorAddress.
 */
export interface CollectorConnection {
  address: string;
  /** Null when the install gives the bearer token only to the collector and
   * not to the Hub: the panel then says where to find it. Telemetry is
   * unaffected either way. */
  token: string | null;
}

export const DEFAULT_COLLECTOR_ADDRESS = 'http://localhost:4318';

export function getCollectorConnection(
  env: Record<string, string | undefined> = process.env,
  savedAddress = '',
): CollectorConnection {
  const token = (env.CCC_CLIENT_BEARER_TOKEN ?? '').trim() || null;
  const address = savedAddress.trim() || (env.CCC_COLLECTOR_ADDRESS ?? '').trim() || DEFAULT_COLLECTOR_ADDRESS;
  return { address, token };
}

/**
 * The address as it should be saved, or null when it is not an http or https
 * address. Blank is allowed and means "use the default". A trailing slash is
 * dropped, since Claude adds the path itself.
 */
export function normaliseCollectorAddress(input: string): string | null {
  const value = input.trim();
  if (value === '') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
  } catch {
    return null;
  }
  return value.replace(/\/+$/, '');
}

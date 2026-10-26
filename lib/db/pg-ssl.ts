// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * How the Hub encrypts its connection to PostgreSQL.
 *
 * CCC_PG_SSL, when set, decides: `disable` (no TLS), `no-verify` (TLS without
 * checking the certificate) or `require` (TLS with the certificate verified).
 * When it is not set, the database address decides: the bundled database
 * (`postgres`, the Docker Compose service) and this machine (`localhost`,
 * `127.0.0.1`, `::1`) get no TLS, and every other address gets verified TLS.
 * So pointing DATABASE_URL at a managed database is encrypted by default,
 * without anyone having to remember a setting.
 *
 * scripts/pg-ssl.mjs is the same rule for the plain Node scripts;
 * test/pg-ssl.test.ts keeps the two in step.
 */
export type PgSslMode = 'disable' | 'no-verify' | 'require';

const UNENCRYPTED_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '::1', '[::1]']);

export function resolvePgSslMode(setting: string | undefined, databaseUrl: string | undefined): PgSslMode {
  const value = (setting ?? '').trim().toLowerCase();
  if (value === 'disable' || value === 'no-verify' || value === 'require') return value;
  // Any other non-empty value has always meant verified TLS.
  if (value) return 'require';
  let host = '';
  try {
    host = new URL(databaseUrl ?? '').hostname.toLowerCase();
  } catch {
    host = '';
  }
  return UNENCRYPTED_HOSTS.has(host) ? 'disable' : 'require';
}

export function pgSslOption(
  setting: string | undefined,
  databaseUrl: string | undefined,
): undefined | { rejectUnauthorized: boolean } {
  const mode = resolvePgSslMode(setting, databaseUrl);
  if (mode === 'disable') return undefined;
  return { rejectUnauthorized: mode === 'require' };
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The database TLS rule from lib/db/pg-ssl.ts, for the plain Node scripts
// that cannot import TypeScript. Keep the two identical: test/pg-ssl.test.ts
// checks they agree.
const UNENCRYPTED_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '::1', '[::1]']);

export function resolvePgSslMode(setting, databaseUrl) {
  const value = (setting ?? '').trim().toLowerCase();
  if (value === 'disable' || value === 'no-verify' || value === 'require') return value;
  if (value) return 'require';
  let host = '';
  try {
    host = new URL(databaseUrl ?? '').hostname.toLowerCase();
  } catch {
    host = '';
  }
  return UNENCRYPTED_HOSTS.has(host) ? 'disable' : 'require';
}

export function pgSslOption(setting, databaseUrl) {
  const mode = resolvePgSslMode(setting, databaseUrl);
  if (mode === 'disable') return undefined;
  return { rejectUnauthorized: mode === 'require' };
}

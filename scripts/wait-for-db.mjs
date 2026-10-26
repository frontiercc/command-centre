// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// scripts/wait-for-db.mjs
// Boot gate. Run before `node server.js` in the Docker CMD. It polls
// `SELECT 1` until Postgres answers, then lets the server start. It NEVER
// blocks past the timeout: after the cap it logs loudly and returns so the
// server starts anyway (the degraded banner then tells the admin). Exit code is
// always 0 — a genuinely broken DSN must not wedge the container forever.

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_LOG_EVERY_MS = 15_000;

/**
 * Pure, injectable poll loop.
 *
 * @param {{
 *   probe?: () => Promise<boolean>,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   logEveryMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{ ready: boolean, timedOut: boolean, attempts: number }>}
 */
export async function waitForDb({
  probe,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logEveryMs = DEFAULT_LOG_EVERY_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (msg) => console.log(msg),
} = {}) {
  const start = now();
  let attempts = 0;
  let lastLog = -Infinity;

  for (;;) {
    attempts++;
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) {
      log(`[wait-for-db] database ready after ${attempts} attempt(s).`);
      return { ready: true, timedOut: false, attempts };
    }

    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      log(`[wait-for-db] DB still unreachable after ${Math.round(timeoutMs / 1000)}s ` +
          `- starting degraded; the UI will show the database-unavailable banner.`);
      return { ready: false, timedOut: true, attempts };
    }
    if (now() - lastLog >= logEveryMs) {
      log(`[wait-for-db] waiting for database... (${Math.round(elapsed / 1000)}s elapsed)`);
      lastLog = now();
    }
    await sleep(intervalMs);
  }
}

/**
 * Real Postgres probe honouring the same env contract as lib/db/client.ts.
 */
async function pgProbe() {
  const { Client } = await import('pg');
  const { pgSslOption } = await import('./pg-ssl.mjs');
  const ssl = pgSslOption(process.env.CCC_PG_SSL, process.env.DATABASE_URL);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl,
    // Bound a single connect attempt well under the poll interval (3s) so an
    // unreachable host can't hang past the loop's overall timeoutMs.
    connectionTimeoutMillis: 2500,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } finally {
    await client.end().catch(() => {});
  }
}

// CLI entrypoint: run only when executed directly (not when imported by tests).
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  waitForDb({ probe: pgProbe })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[wait-for-db] unexpected error, starting anyway:', err);
      process.exit(0);
    });
}

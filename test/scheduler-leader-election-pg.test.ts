// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The unit tests drive the election with a fake client. This proves the same
// behaviour against a real postgres:16: one leader among concurrent starters,
// takeover when the leader's backend is terminated (what an RDS failover does
// to every session), and no interaction with a single-connection app pool.
//
// Requires Docker. On a Windows machine run with
// NODE_OPTIONS=--dns-result-order=ipv4first (Docker Desktop's proxy answers
// IPv4 only). Skips cleanly when Docker is absent, like migration-lock.test.ts.
import { describe, it, expect } from 'vitest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** pred may be sync or async — the zero-locks-after-stop() check below needs a query per poll. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

describe('scheduler leader election (postgres)', () => {
  it(
    'elects exactly one leader, hands over when the leader backend is terminated, and never borrows from the app pool',
    async () => {
      const { startPg } = await import('./helpers/pg');
      const { startLeaderElection } = await import('@/lib/db/scheduler-lock');
      const { Client, Pool } = await import('pg');
      const { container, pool, url } = await startPg();

      const elected: number[] = [];
      const demoted: number[] = [];
      const elections = [0, 1, 2, 3].map((i) =>
        startLeaderElection({
          createClient: () => new Client({ connectionString: url }),
          onElected: () => elected.push(i),
          onDemoted: () => demoted.push(i),
          retryMs: 200,
          heartbeatMs: 200,
          log: () => {},
        }),
      );

      try {
        await waitFor(() => elected.length === 1, 5_000, 'first leader');
        await sleep(700); // every follower has retried at least twice
        expect(elected).toHaveLength(1);
        expect(elections.filter((e) => e.isLeader())).toHaveLength(1);

        // Exactly one advisory lock is held, by the leader's own backend.
        // pg_locks is server-wide; count only this test's database, since a
        // shared test server (CCC_TEST_PG_URL) also holds other files' locks.
        const held = await pool.query(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND granted",
        );
        expect(held.rows).toHaveLength(1);
        const leaderPid = held.rows[0].pid as number;

        // The election's connection is NOT the app pool's: a one-connection
        // pool still serves a query while the lock is held.
        const single = new Pool({ connectionString: url, max: 1 });
        try {
          const r = await single.query('SELECT 1 AS ok');
          expect(r.rows[0].ok).toBe(1);
        } finally {
          await single.end();
        }

        // Kill the leader's backend, as a failover would. Postgres drops the
        // lock with the session; the old leader must stand down and someone
        // (possibly the same instance) must take over.
        await pool.query('SELECT pg_terminate_backend($1)', [leaderPid]);
        await waitFor(() => demoted.length === 1, 5_000, 'old leader to demote');
        await waitFor(() => elected.length === 2, 5_000, 'new leader');
        await sleep(700);
        expect(elections.filter((e) => e.isLeader())).toHaveLength(1);
        const heldAfter = await pool.query(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND granted",
        );
        expect(heldAfter.rows).toHaveLength(1);
        expect(heldAfter.rows[0].pid).not.toBe(leaderPid);

        await Promise.all(elections.map((e) => e.stop()));
        // stop()'s explicit unlock and the session actually closing both race
        // a little from Postgres's point of view — poll rather than assert
        // immediately, so this isn't flaky under load.
        await waitFor(
          async () => {
            const after = await pool.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
            );
            return after.rows[0].n === 0;
          },
          5_000,
          'all advisory locks released after stop()',
        );
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    120_000,
  );
});

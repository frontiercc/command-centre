// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Scheduled jobs must run on exactly ONE application instance. Every Node
// process starts the scheduler otherwise, which is right for one instance and
// wrong once the compute tier autoscales: every replica would fire every job
// on every cadence (duplicate digests and alerts, duplicated AI spend, a
// use-case tracker cursor advanced twice over the same rows).
//
// An earlier version chose the instance with an env var (CCC_SCHEDULER=off on the
// autoscaled replicas, unset on one dedicated task). ECS Fargate and Azure
// Container Apps give every replica of a service the same environment block,
// so that cannot be expressed on a single autoscaled service. This replaces
// it with leader election on a Postgres ADVISORY lock: each instance tries
// for the lock at boot, the holder runs the scheduler, the others retry, and a
// live instance takes over when the holder's connection dies (Postgres
// releases a session-level advisory lock the moment the session ends, so no
// handover protocol is needed).
//
// The lock lives on a DEDICATED pg.Client, never a pool connection. The lock
// must be held for the process lifetime, and a pool connection held that long
// would starve a CCC_PG_POOL_MAX=1 deployment (the lesson migration-lock.ts
// already paid for). It also means the election owns the connection's error
// and end events, which is how a demoted leader finds out it has lost.

// Any stable 64-bit constant works; it only has to be unique within this
// database. Advisory locks are namespaced by value, so this number IS the
// lock's identity. Distinct from MIGRATION_LOCK_ID; never reuse either.
export const SCHEDULER_LOCK_ID = 4_726_301_180_000_002;

/**
 * A Postgres bigint advisory lock is stored in pg_locks split into two int4
 * halves (classid = high 32 bits, objid = low 32 bits, objsubid = 1) — this is
 * how the heartbeat below looks itself up. Pure so it's unit-testable without
 * a database.
 */
export function advisoryLockKey(lockId: number): { classid: number; objid: number } {
  const id = BigInt(lockId);
  const shift = BigInt(32);
  const mask = BigInt(0xffffffff);
  return { classid: Number(id >> shift), objid: Number(id & mask) };
}

/** The slice of pg.Client the election uses. Narrow so tests can fake it. */
export interface ElectionClient {
  /** pg.Client resolves to itself here; the election awaits and ignores the value. */
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
}

export interface LeaderElectionOptions {
  /** Opens a NEW client each call. Must not hand out a pooled connection. */
  createClient: () => ElectionClient;
  /** Called once each time this instance becomes leader (startScheduler). */
  onElected: () => void;
  /** Called once each time this instance stops being leader (stopScheduler). */
  onDemoted: () => void;
  /** How often a follower re-tries the lock, and a demoted leader rejoins. Default 30s. */
  retryMs?: number;
  /** How often the leader proves its connection is alive with SELECT 1. Default 30s. */
  heartbeatMs?: number;
  /** Override only in tests. */
  lockId?: number;
  log?: (message: string) => void;
}

export interface LeaderElection {
  isLeader(): boolean;
  /** Graceful shutdown: cancel timers, stop the scheduler if leading, release the lock, end the client. */
  stop(): Promise<void>;
}

export function startLeaderElection(opts: LeaderElectionOptions): LeaderElection {
  const retryMs = opts.retryMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const lockId = opts.lockId ?? SCHEDULER_LOCK_ID;
  const log = opts.log ?? ((message: string) => console.log(`[Scheduler leader] ${message}`));

  let leader = false;
  let stopped = false;
  let client: ElectionClient | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  // Detach whatever listeners this client carries (the demote-triggering
  // error/end handlers, if it ever became leader), then re-attach a swallowing
  // 'error' listener before end(). A node-postgres Client emits 'error' for a
  // connection-level failure with no query in flight; an EventEmitter that
  // emits 'error' with zero listeners throws ERR_UNHANDLED_ERROR and takes the
  // process down, and end() itself can surface a late socket error during
  // teardown. Always operates on the client instance it is given directly,
  // never the shared `client` variable, which a concurrent stop() may have
  // already superseded.
  const endClient = async (c: ElectionClient): Promise<void> => {
    c.removeAllListeners?.();
    c.on('error', () => {});
    try {
      await c.end();
    } catch {
      /* already gone */
    }
  };

  // Best-effort release of a client that turned out not to be needed after
  // all (a stale attempt, or one stop() has already superseded): explicitly
  // unlock only if we believe this client's session acquired the lock, then
  // end it. A failed unlock is fine — ending the session releases it anyway.
  const releaseAndDiscard = async (c: ElectionClient, acquired: boolean): Promise<void> => {
    if (acquired) {
      try {
        await c.query('SELECT pg_advisory_unlock($1)', [lockId]);
      } catch {
        /* connection already gone; ending the session releases it anyway */
      }
    }
    await endClient(c);
  };

  // Discards whatever the shared `client` variable currently holds. Only
  // demote() uses this — it is reacting to an event on the client that IS
  // still the current one.
  const discard = async (): Promise<void> => {
    const c = client;
    client = null;
    if (!c) return;
    await endClient(c);
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attempt();
    }, retryMs);
  };

  const demote = (why: string): void => {
    if (!leader || stopped) return;
    leader = false;
    clearTimers();
    log(`demoted (${why}). Scheduler stopped on this instance; contending again in ${retryMs / 1000}s`);
    try {
      opts.onDemoted();
    } catch (err) {
      log(`onDemoted threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    void discard().then(scheduleRetry);
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    // Declared here, not as a `const` bound by createClient()'s call, so that
    // a throw from createClient() ITSELF (e.g. a connection-config helper
    // validating DATABASE_URL) lands in the catch below like any other
    // failure. Every call site does `void attempt()`, so a rejection that
    // instead escaped this function would be unhandled (process-fatal under
    // Node's default policy) and, worse, would skip scheduleRetry() — this
    // instance would never contend again.
    let c: ElectionClient | null = null;
    let acquired = false;
    try {
      const created = opts.createClient();
      c = created;
      client = created;
      // Swallow until (if) we're leading, when the real demote-triggering
      // listener is added on top of this one — see the comment on endClient.
      created.on('error', () => {});
      await created.connect();
      const result = await created.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
      acquired = result.rows[0]?.acquired === true;

      // stop() may have run while we were awaiting the lock query. Never act
      // on the outcome of a query we no longer care about.
      if (stopped) {
        if (client === created) client = null;
        await releaseAndDiscard(created, acquired);
        return;
      }

      if (!acquired) {
        if (client === created) client = null;
        await endClient(created);
        log(`another instance holds the scheduler lock. Following; retry in ${retryMs / 1000}s`);
        scheduleRetry();
        return;
      }

      // Re-check before committing to leadership. Nothing awaits between the
      // acquired-check above and here today, so this cannot currently fire —
      // it is belt-and-braces against a future edit introducing an await in
      // that gap, not a live race.
      if (stopped) {
        if (client === created) client = null;
        await releaseAndDiscard(created, true);
        return;
      }

      leader = true;
      created.on('error', (err) => demote(`connection error: ${err instanceof Error ? err.message : String(err)}`));
      created.on('end', () => demote('connection closed'));
      // The heartbeat proves this session still OWNS the lock, not merely
      // that the connection is alive. A `SELECT 1` would only prove liveness:
      // behind a transaction-mode pooler (RDS Proxy, PgBouncer in transaction
      // mode) `pg_try_advisory_lock` can "succeed" against a pooled backend
      // and the lock never actually persists past that backend being handed
      // back to the pool, while the connection itself keeps answering queries
      // fine — every replica would then believe it holds the lock and run
      // every job. Querying pg_locks for THIS backend's own pid catches that
      // silently, on the next heartbeat, instead of never. This REQUIRES a
      // session-mode connection to Postgres (no transaction-mode pooler in
      // front of the hub, or the hub must bypass it).
      const { classid, objid } = advisoryLockKey(lockId);
      heartbeatTimer = setInterval(() => {
        created
          .query(
            "SELECT count(*)::int AS n FROM pg_locks" +
              " WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1 AND pid = pg_backend_pid()",
            [classid, objid],
          )
          .then((result) => {
            const n = Number(result.rows[0]?.n ?? 0);
            if (n !== 1) demote('lock not held by this session');
          })
          .catch((err: unknown) => demote(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`));
      }, heartbeatMs);
      log('acquired. This instance runs the scheduled jobs');

      try {
        opts.onElected();
      } catch (err) {
        log(`onElected threw: ${err instanceof Error ? err.message : String(err)}`);
        // Rethrow into the outer catch below, which is the single place that
        // resets leader/timers before discarding — no path may leave
        // `leader` true without actually holding the lock.
        throw err;
      }
    } catch (err) {
      leader = false;
      clearTimers();
      if (client === c) client = null;
      if (c) await releaseAndDiscard(c, acquired);
      log(`attempt failed (${err instanceof Error ? err.message : String(err)}). Retry in ${retryMs / 1000}s`);
      scheduleRetry();
    }
  };

  void attempt();

  return {
    isLeader: () => leader,
    async stop(): Promise<void> {
      stopped = true;
      clearTimers();
      const wasLeader = leader;
      leader = false;
      const c = client;
      client = null;
      if (!c) return;
      if (wasLeader) {
        // Belt and braces: the session ending releases the lock anyway.
        try {
          await c.query('SELECT pg_advisory_unlock($1)', [lockId]);
        } catch {
          /* released on session end */
        }
        try {
          opts.onDemoted();
        } catch (err) {
          log(`onDemoted threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await endClient(c);
    },
  };
}

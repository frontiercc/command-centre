// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Exactly one application instance may run the scheduled jobs. Each instance
// contends for a Postgres advisory lock at boot; the holder runs the
// scheduler, the others retry, and a live instance takes over when the
// holder's connection dies. These tests drive that loop with a fake client so
// they need no Postgres. test/scheduler-leader-election-pg.test.ts proves the
// same thing against a real postgres:16.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  startLeaderElection,
  SCHEDULER_LOCK_ID,
  advisoryLockKey,
  type ElectionClient,
} from '@/lib/db/scheduler-lock';

/** One shared "server" per test: who holds the lock. */
type LockState = { holder: FakeClient | null };

/** A promise plus its own resolve, so a test can hold up a fake client's await. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakeClient extends EventEmitter implements ElectionClient {
  ended = false;
  queries: string[] = [];
  heartbeatShouldFail = false;
  /** listenerCount('error') at the moment end() ran — proves a listener was present before teardown. */
  errorListenerCountAtEnd: number | null = null;
  /** Test-controlled gates: when set, connect()/the lock query await these before proceeding. */
  connectGate: Promise<void> | null = null;
  lockQueryGate: Promise<void> | null = null;
  constructor(private lock: LockState, private failConnect = false) {
    super();
  }
  async connect(): Promise<void> {
    if (this.connectGate) await this.connectGate;
    if (this.failConnect) throw new Error('ECONNREFUSED');
  }
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push(text);
    if (this.ended) throw new Error('Client was closed');
    if (text.startsWith('SELECT pg_try_advisory_lock')) {
      if (this.lockQueryGate) await this.lockQueryGate;
      if (this.lock.holder === null || this.lock.holder === this) {
        this.lock.holder = this;
        return { rows: [{ acquired: true }] };
      }
      return { rows: [{ acquired: false }] };
    }
    if (text.startsWith('SELECT pg_advisory_unlock')) {
      if (this.lock.holder === this) this.lock.holder = null;
      return { rows: [{ released: true }] };
    }
    if (text.startsWith('SELECT count(*)::int AS n FROM pg_locks')) {
      // Heartbeat: proves THIS session still owns the lock (see scheduler-lock.ts).
      // A pooler split (backend returned to the pool, lock never persisted) shows
      // up here as lock.holder having moved on without an 'error'/'end' ever firing.
      if (this.heartbeatShouldFail) throw new Error('Connection terminated unexpectedly');
      return { rows: [{ n: this.lock.holder === this ? 1 : 0 }] };
    }
    if (this.heartbeatShouldFail) throw new Error('Connection terminated unexpectedly');
    return { rows: [{ ok: 1 }] };
  }
  async end(): Promise<void> {
    this.errorListenerCountAtEnd = this.listenerCount('error');
    this.ended = true;
    if (this.lock.holder === this) this.lock.holder = null;
    this.emit('end');
  }
  /** Server-side kill (RDS failover, pg_terminate_backend): lock gone, then 'end'.
   *  withError also emits 'error' first, in the same tick, as a real driver can. */
  kill(withError = false): void {
    if (withError) this.emit('error', new Error('terminated'));
    if (this.lock.holder === this) this.lock.holder = null;
    this.ended = true;
    this.emit('end');
  }
}

const RETRY = 1_000;
const HEARTBEAT = 500;

function harness(
  lock: LockState,
  opts: {
    failConnectFirst?: boolean;
    onElected?: () => void;
    gateFirstClientConnect?: Promise<void>;
    gateFirstClientLockQuery?: Promise<void>;
  } = {},
) {
  const clients: FakeClient[] = [];
  const onElected = opts.onElected ? vi.fn(opts.onElected) : vi.fn();
  const onDemoted = vi.fn();
  let first = true;
  const election = startLeaderElection({
    createClient: () => {
      const isFirst = first;
      const c = new FakeClient(lock, opts.failConnectFirst === true && isFirst);
      if (isFirst && opts.gateFirstClientConnect) c.connectGate = opts.gateFirstClientConnect;
      if (isFirst && opts.gateFirstClientLockQuery) c.lockQueryGate = opts.gateFirstClientLockQuery;
      first = false;
      clients.push(c);
      return c;
    },
    onElected,
    onDemoted,
    retryMs: RETRY,
    heartbeatMs: HEARTBEAT,
    log: () => {},
  });
  return { election, clients, onElected, onDemoted };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startLeaderElection', () => {
  it('becomes leader when the lock is free and calls onElected exactly once', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onElected).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(true);
    expect(h.clients[0].queries[0]).toContain('pg_try_advisory_lock');
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(h.onElected).toHaveBeenCalledTimes(1);
    await h.election.stop();
  });

  it('follows while another instance holds the lock, ends its client, and takes over once the lock is free', async () => {
    const lock: LockState = { holder: null };
    const leader = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(leader.election.isLeader()).toBe(true);

    const follower = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(follower.onElected).not.toHaveBeenCalled();
    expect(follower.election.isLeader()).toBe(false);
    expect(follower.clients[0].ended).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(follower.clients).toHaveLength(2);
    expect(follower.onElected).not.toHaveBeenCalled();

    // Leader's backend dies: lock released server-side.
    leader.clients[0].kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(leader.onDemoted).toHaveBeenCalledTimes(1);
    expect(leader.election.isLeader()).toBe(false);

    // The demoted leader also retries; whoever's timer fires first wins.
    await vi.advanceTimersByTimeAsync(RETRY);
    const leaders = [leader, follower].filter((h) => h.election.isLeader());
    expect(leaders).toHaveLength(1);
    expect(leader.onElected.mock.calls.length + follower.onElected.mock.calls.length).toBe(2);

    await leader.election.stop();
    await follower.election.stop();
  });

  it('demotes when a heartbeat fails and contends again', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.election.isLeader()).toBe(true);

    h.clients[0].heartbeatShouldFail = true;
    // Simulate the server having dropped the session along with the lock.
    lock.holder = null;
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(h.onDemoted).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.onElected).toHaveBeenCalledTimes(2);
    expect(h.election.isLeader()).toBe(true);
    expect(h.clients).toHaveLength(2);
    await h.election.stop();
  });

  it('retries after a connection failure without throwing', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock, { failConnectFirst: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onElected).not.toHaveBeenCalled();
    expect(h.election.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.onElected).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(true);
    await h.election.stop();
  });

  it('stop() while leading releases the lock explicitly, stops the scheduler and ends the client', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    await h.election.stop();
    expect(h.clients[0].queries.some((q) => q.startsWith('SELECT pg_advisory_unlock'))).toBe(true);
    expect(h.onDemoted).toHaveBeenCalledTimes(1);
    expect(h.clients[0].ended).toBe(true);
    expect(lock.holder).toBeNull();
    expect(h.election.isLeader()).toBe(false);
    // No further attempts after stop.
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(h.clients).toHaveLength(1);
  });

  it('stop() while following just cancels the retry', async () => {
    const lock: LockState = { holder: null };
    const leader = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    const follower = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    await follower.election.stop();
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(follower.clients).toHaveLength(1);
    expect(follower.onDemoted).not.toHaveBeenCalled();
    await leader.election.stop();
  });

  it('uses a lock id distinct from the migration lock', async () => {
    const { MIGRATION_LOCK_ID } = await import('@/lib/db/migration-lock');
    expect(SCHEDULER_LOCK_ID).not.toBe(MIGRATION_LOCK_ID);
    expect(Number.isSafeInteger(SCHEDULER_LOCK_ID)).toBe(true);
  });

  it('advisoryLockKey splits the default lock id into the classid/objid pg_locks stores it under', () => {
    expect(advisoryLockKey(SCHEDULER_LOCK_ID)).toEqual({ classid: 1_100_427, objid: 3_203_364_610 });
  });

  it('demotes when the lock is no longer held by this session, even with no error/end (pooler split)', async () => {
    // Behind a transaction-mode pooler, pg_try_advisory_lock can "succeed" on a
    // pooled backend and the lock never actually persists past that backend
    // being returned to the pool — the connection stays open (no 'error'/'end'
    // ever fires), so only a heartbeat that checks OWNERSHIP, not liveness,
    // catches it. Simulated here by moving the lock's holder without calling
    // kill()/end() on the client at all.
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.election.isLeader()).toBe(true);

    lock.holder = null;
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(h.onDemoted).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(false);
    expect(h.clients[0].ended).toBe(true);

    // Still rejoins the retry loop and can win again once free.
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.onElected).toHaveBeenCalledTimes(2);
    expect(h.election.isLeader()).toBe(true);
    await h.election.stop();
  });

  it('discards leader state when onElected throws, and elects again on the next attempt', async () => {
    const lock: LockState = { holder: null };
    let calls = 0;
    const h = harness(lock, {
      onElected: () => {
        calls++;
        if (calls === 1) throw new Error('onElected boom');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onElected).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(false);
    expect(lock.holder).toBeNull();
    expect(h.clients[0].ended).toBe(true);

    const queryCountAfterFailedElection = h.clients[0].queries.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2);
    expect(h.clients[0].queries.length).toBe(queryCountAfterFailedElection);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.onElected).toHaveBeenCalledTimes(2);
    expect(h.election.isLeader()).toBe(true);
    await h.election.stop();
  });

  it('stop() racing an in-flight connect() never elects, ends the client and never retries', async () => {
    const lock: LockState = { holder: null };
    const gate = deferred();
    const h = harness(lock, { gateFirstClientConnect: gate.promise });
    await h.election.stop();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onElected).not.toHaveBeenCalled();
    expect(h.election.isLeader()).toBe(false);
    expect(h.clients[0].ended).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(h.clients).toHaveLength(1);
  });

  it('stop() racing an in-flight lock query releases the lock instead of electing', async () => {
    const lock: LockState = { holder: null };
    const gate = deferred();
    const h = harness(lock, { gateFirstClientLockQuery: gate.promise });
    // Let attempt() run past the unGated connect() and suspend on our gate
    // inside the lock query, before stop() races it.
    await vi.advanceTimersByTimeAsync(0);
    await h.election.stop();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.clients[0].queries.some((q) => q.startsWith('SELECT pg_advisory_unlock'))).toBe(true);
    expect(h.onElected).not.toHaveBeenCalled();
    expect(h.election.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(h.clients).toHaveLength(1);
  });

  it('never leaves a client without an error listener registered before it ends', async () => {
    const lock: LockState = { holder: null };
    const leader = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(leader.election.isLeader()).toBe(true);

    const follower = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(follower.clients[0].ended).toBe(true);
    expect(follower.clients[0].errorListenerCountAtEnd).toBeGreaterThan(0);

    leader.clients[0].kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(leader.onDemoted).toHaveBeenCalledTimes(1);
    expect(leader.clients[0].errorListenerCountAtEnd).toBeGreaterThan(0);

    await leader.election.stop();
    await follower.election.stop();
  });

  it('clears the heartbeat timer on demotion so no heartbeat query runs afterwards', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.election.isLeader()).toBe(true);

    h.clients[0].kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onDemoted).toHaveBeenCalledTimes(1);

    const queryCountAtDemotion = h.clients[0].queries.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 3);
    expect(h.clients[0].queries.length).toBe(queryCountAtDemotion);
    await h.election.stop();
  });

  it('demotes exactly once when a kill emits error then end in the same tick', async () => {
    const lock: LockState = { holder: null };
    const h = harness(lock);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.election.isLeader()).toBe(true);

    h.clients[0].kill(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onDemoted).toHaveBeenCalledTimes(1);
    expect(h.election.isLeader()).toBe(false);

    await h.election.stop();
  });

  it('recovers when createClient() itself throws on the first attempt, with no unhandled rejection', async () => {
    // createClient() can throw synchronously before any client exists — e.g. a
    // connection-config helper validating DATABASE_URL. Every call site does
    // `void attempt()`, so if that throw escaped attempt() as a rejected
    // promise, it would be an unhandled rejection (process-fatal under Node's
    // default policy) and scheduleRetry() would never run, so this instance
    // would never contend again. We assert directly via
    // process.on('unhandledRejection') rather than relying on Vitest to fail
    // the run on one, since we want to name the exact absence in this test.
    const lock: LockState = { holder: null };
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      let calls = 0;
      const onElected = vi.fn();
      const onDemoted = vi.fn();
      const election = startLeaderElection({
        createClient: () => {
          calls++;
          if (calls === 1) throw new Error('DATABASE_URL is not set');
          return new FakeClient(lock);
        },
        onElected,
        onDemoted,
        retryMs: RETRY,
        heartbeatMs: HEARTBEAT,
        log: () => {},
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(onElected).not.toHaveBeenCalled();
      expect(election.isLeader()).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY);
      expect(onElected).toHaveBeenCalledTimes(1);
      expect(election.isLeader()).toBe(true);

      // Give any stray unhandled-rejection microtask a chance to surface
      // before we assert none did.
      await Promise.resolve();
      expect(unhandled).toHaveLength(0);

      await election.stop();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

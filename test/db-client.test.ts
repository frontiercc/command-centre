// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Drizzle client factory: getClient()/getAuditClient() round-trip a real
// Postgres query and behave as singletons.
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

describe('getClient (postgres)', () => {
  type PgHolder = {
    __ccc_client?: unknown;
    __ccc_client_promise?: unknown;
    __ccc_pgpool?: { end?: () => Promise<void> };
    __ccc_audit_client?: unknown;
    __ccc_audit_client_promise?: unknown;
    __ccc_audit_pgpool?: { end?: () => Promise<void> };
  };
  // A pg-bound Drizzle client exposes execute(); narrow to just that.
  type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };

  let cleanup: () => Promise<void>;

  // End the pools before dropping the singletons, so a cleared client never
  // leaves a connected pool behind for the rest of the process.
  async function clearSingletons() {
    const proc = process as unknown as PgHolder;
    try { await proc.__ccc_pgpool?.end?.(); } catch { /* already ended */ }
    try { await proc.__ccc_audit_pgpool?.end?.(); } catch { /* already ended */ }
    delete proc.__ccc_client;
    delete proc.__ccc_client_promise;
    delete proc.__ccc_pgpool;
    delete proc.__ccc_audit_client;
    delete proc.__ccc_audit_client_promise;
    delete proc.__ccc_audit_pgpool;
  }

  beforeAll(async () => {
    // A migrated per-file database; sets DATABASE_URL and
    // resets modules, so the imports below get a fresh lib/db/client.
    ({ cleanup } = await createTestDatabase());
  });

  afterAll(async () => cleanup());

  it('returns a working postgres-bound client that can round-trip a real query', async () => {
    const { getClient } = await import('@/lib/db/client');
    const client = (await getClient()) as unknown as Executor;

    // getClient() self-bootstraps the schema migrations on first open, so the
    // database is already fully migrated; test_kv is an extra scratch table
    // not in the migration set, so its CREATE never collides.
    await client.execute(sql`CREATE TABLE test_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await client.execute(sql`INSERT INTO test_kv (k, v) VALUES ('hello', 'world')`);
    const { rows } = await client.execute(sql`SELECT k, v FROM test_kv WHERE k = 'hello'`);

    expect(rows).toEqual([{ k: 'hello', v: 'world' }]);
  });

  it('is a singleton per process — a second call returns the same instance', async () => {
    const { getClient } = await import('@/lib/db/client');
    const first = await getClient();
    const second = await getClient();
    expect(second).toBe(first);
  });

  it('concurrent first-callers share one construction (in-flight promise cache, not just check-then-set)', async () => {
    // Regression test for a check-then-set race: two concurrent first-calls
    // could each pass the `if (proc.__ccc_client) return` null-check before
    // either finished constructing, each building its own pg.Pool — the
    // loser's pool leaked silently for the process lifetime.
    // Simulated here by clearing the singleton then firing two calls back to
    // back with no await in between, so both observe the pre-construction
    // state and must resolve to the SAME instance.
    await clearSingletons();

    const { getClient } = await import('@/lib/db/client');
    const [first, second] = await Promise.all([getClient(), getClient()]);

    expect(second).toBe(first);
  });

  it('getAuditClient() opens its own pool, independent of the main client', async () => {
    const { getClient, getAuditClient } = await import('@/lib/db/client');
    const client = await getClient();
    const auditClient = (await getAuditClient()) as unknown as Executor;

    await auditClient.execute(sql`CREATE TABLE test_audit_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await auditClient.execute(sql`INSERT INTO test_audit_kv (k, v) VALUES ('a', 'b')`);
    const { rows } = await auditClient.execute(sql`SELECT k, v FROM test_audit_kv WHERE k = 'a'`);

    expect(rows).toEqual([{ k: 'a', v: 'b' }]);
    expect(auditClient).not.toBe(client);
    const proc = process as unknown as PgHolder;
    expect(proc.__ccc_audit_pgpool).toBeDefined();
    expect(proc.__ccc_audit_pgpool).not.toBe(proc.__ccc_pgpool);
  });
});

// A1 (docs/POSTGRES-LOCAL-FULL-PLAN.md): connection resilience. getClient()/
// getAuditClient() assign the in-flight construction promise to a process-global
// SYNCHRONOUSLY, before the first await, so concurrent first-callers share one
// construction. The gap: if that construction REJECTS (a transient DB blip at
// boot, an RDS failover mid-open), the rejected promise stayed cached, so every
// later call returned that same poisoned rejection — the process was wedged
// until restart. The fix clears the cached promise (and releases any half-built
// pg pool) on rejection so a subsequent call retries.
//
// Exercised on the postgres path with an unreachable DATABASE_URL: the connect
// is refused (fast, no container / Docker needed) so construction rejects, then
// we assert the cache was cleared and the next call is a fresh attempt.
describe('getClient / getAuditClient (connection resilience)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalSsl = process.env.CCC_PG_SSL;

  type PoolHolder = {
    __ccc_client_promise?: unknown;
    __ccc_audit_client_promise?: unknown;
    __ccc_pgpool?: { end?: () => Promise<void> };
    __ccc_audit_pgpool?: { end?: () => Promise<void> };
    __ccc_client?: unknown;
    __ccc_audit_client?: unknown;
  };

  async function clearPgSingletons() {
    const proc = process as unknown as PoolHolder;
    try { await proc.__ccc_pgpool?.end?.(); } catch { /* ignore */ }
    try { await proc.__ccc_audit_pgpool?.end?.(); } catch { /* ignore */ }
    delete proc.__ccc_client;
    delete proc.__ccc_client_promise;
    delete proc.__ccc_pgpool;
    delete proc.__ccc_audit_client;
    delete proc.__ccc_audit_client_promise;
    delete proc.__ccc_audit_pgpool;
  }

  afterEach(async () => {
    await clearPgSingletons();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalSsl === undefined) delete process.env.CCC_PG_SSL;
    else process.env.CCC_PG_SSL = originalSsl;
  });

  it('getClient() clears its cached promise when construction fails, so a later call retries', async () => {
    // Nothing listens on loopback port 1 — connect is refused immediately.
    process.env.DATABASE_URL = 'postgres://ccc:ccc@127.0.0.1:1/nonexistent';
    process.env.CCC_PG_SSL = 'disable';
    await clearPgSingletons();
    vi.resetModules();

    const { getClient } = await import('@/lib/db/client');
    const proc = process as unknown as PoolHolder;

    const first = getClient();
    await expect(first).rejects.toBeTruthy();

    // The poisoned rejection must NOT stay cached (the bug: it did).
    expect(proc.__ccc_client_promise).toBeUndefined();

    const second = getClient();
    // A genuinely fresh attempt, not the cached first rejection handed back.
    expect(second).not.toBe(first);
    await expect(second).rejects.toBeTruthy();
  }, 30_000);

  it('getAuditClient() clears its cached promise when construction fails, so a later call retries', async () => {
    process.env.DATABASE_URL = 'postgres://ccc:ccc@127.0.0.1:1/nonexistent';
    process.env.CCC_PG_SSL = 'disable';
    await clearPgSingletons();
    vi.resetModules();

    const { getAuditClient } = await import('@/lib/db/client');
    const proc = process as unknown as PoolHolder;

    const first = getAuditClient();
    await expect(first).rejects.toBeTruthy();

    expect(proc.__ccc_audit_client_promise).toBeUndefined();

    const second = getAuditClient();
    expect(second).not.toBe(first);
    await expect(second).rejects.toBeTruthy();
  }, 30_000);
});

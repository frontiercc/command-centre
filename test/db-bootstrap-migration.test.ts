// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Bootability keystone proof: the production code path (getClient()/
// getTypedClient()/getAuditClient()) must migrate a FRESH database itself, or
// production queries hit an un-migrated schema. Uses a RAW postgres:16
// container that is deliberately NOT pre-migrated (no applyPgMigrations /
// startPg), so a successful query against a migrated table proves getClient()
// itself ran the drizzle-kit migrations. It needs its own container, so it is
// Docker-gated (skipped on a Docker-less box) — the one test that cannot use
// the shared CCC_TEST_PG_URL server.
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

type RawHandleHolder = {
  __ccc_client?: { $client?: { close?: () => void; end?: () => Promise<void> } };
  __ccc_client_promise?: unknown;
  __ccc_pgpool?: unknown;
  __ccc_audit_client?: { $client?: { close?: () => void; end?: () => Promise<void> } };
  __ccc_audit_client_promise?: unknown;
  __ccc_audit_pgpool?: unknown;
};

async function clearClientSingletons(): Promise<void> {
  const proc = process as unknown as RawHandleHolder;
  for (const key of ['__ccc_client', '__ccc_audit_client'] as const) {
    const raw = proc[key]?.$client;
    try {
      if (raw?.end) await raw.end();
      else raw?.close?.();
    } catch {
      /* already closed */
    }
  }
  delete proc.__ccc_client;
  delete proc.__ccc_client_promise;
  delete proc.__ccc_pgpool;
  delete proc.__ccc_audit_client;
  delete proc.__ccc_audit_client_promise;
  delete proc.__ccc_audit_pgpool;
}

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
const maybeDescribe = HAS_DOCKER ? describe : describe.skip;

maybeDescribe('client path self-bootstraps migrations (postgres)', () => {
  // Imported lazily so a Docker-less box never loads testcontainers.
  let container: StartedPostgreSqlContainer | undefined;
  const originalUrl = process.env.DATABASE_URL;
  const originalSsl = process.env.CCC_PG_SSL;

  afterAll(async () => {
    await clearClientSingletons();
    await container?.stop();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalSsl === undefined) delete process.env.CCC_PG_SSL;
    else process.env.CCC_PG_SSL = originalSsl;
  });

  it('getTypedClient() queries a migrated table against a FRESH (un-migrated) container', async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    // RAW container — deliberately NOT migrated via startPg()/applyPgMigrations,
    // so the ONLY thing that can create the schema is getClient() itself.
    container = await new PostgreSqlContainer('postgres:16').start();
    const url = container.getConnectionUri();

    process.env.DATABASE_URL = url;
    process.env.CCC_PG_SSL = 'disable';
    await clearClientSingletons();
    vi.resetModules();

    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    const rows = await client.select().from((await import('@/lib/db/schema')).schema.config);
    expect(Array.isArray(rows)).toBe(true);
  }, 180_000);
});

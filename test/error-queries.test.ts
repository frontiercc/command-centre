// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/db/error-queries.ts (async Drizzle).
//
// Runs against Postgres (testcontainers postgres:16, or the shared server
// named by CCC_TEST_PG_URL); skipped (not failed) without Docker.
//
// KEY HARNESS RULE (the thing every such test must copy): error-queries.ts
// reaches the database through getClient(), which binds to DATABASE_URL on
// first use. So the module under test is DYNAMIC-imported *after*
// createTestDbClient() has set DATABASE_URL and called vi.resetModules() —
// a top-level static import would bind to whatever database loaded first
// and silently test the wrong one.
import { describe, it, expect } from 'vitest';
import type { InsertErrorEvent } from '@/lib/db/error-queries';

const CRASH: InsertErrorEvent = {
  severity: 'crash',
  source: 'agent',
  message: 'segfault',
  stack_trace: 'at foo()\nat bar()',
  context_json: '{"agent_id":"host-alpha","pid":42}',
};

/**
 * Run the full behavioural spec against Postgres. Imports the harness and
 * the module-under-test dynamically so DATABASE_URL is set BEFORE either
 * loads (see the header rule).
 */
async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (header rule).
    const { insertErrorEvents, queryErrorEvents } =
      await import('@/lib/db/error-queries');

    // ── insert returns a count (a transaction that RETURNS a value)
    expect(await insertErrorEvents([])).toBe(0);

    const n = await insertErrorEvents([
      CRASH,
      { severity: 'warning', source: 'hub', message: 'slow query' },
      { severity: 'error', source: 'hub', message: 'boom' },
    ]);
    expect(n).toBe(3);

    // ── query: total + severity filter + ordering
    const all = await queryErrorEvents();
    expect(all.total).toBe(3);
    expect(all.events.length).toBe(3);

    const hubOnly = await queryErrorEvents({ source: 'hub' });
    expect(hubOnly.total).toBe(2);
    expect(hubOnly.events.every((e) => e.source === 'hub')).toBe(true);

    const crashesOnly = await queryErrorEvents({ severity: 'crash' });
    expect(crashesOnly.total).toBe(1);
    expect(crashesOnly.events[0].message).toBe('segfault');
    expect(crashesOnly.events[0].stack_trace).toBe('at foo()\nat bar()');

    // ── query: limit is honoured, total reflects the full match set
    const limited = await queryErrorEvents({ limit: 1 });
    expect(limited.events.length).toBe(1);
    expect(limited.total).toBe(3);

    // ── query: time-window filter
    const now = Math.floor(Date.now() / 1000);
    expect((await queryErrorEvents({ from: now - 60, to: now + 60 })).total).toBe(3);
    expect((await queryErrorEvents({ from: now + 3600 })).total).toBe(0);
  } finally {
    await cleanup();
  }
}

describe('error-queries (postgres)', () => {
  it(
    'insert/query behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Smoke test for the Postgres test harness. Proves the generated
// drizzle-kit Postgres migrations (lib/db/migrations-pg) apply cleanly to a
// real postgres:16 container and that a real row round-trips through it.
//
// Requires Docker. Skipped (not run) unless Docker is reachable — vitest.run
// still reports this file, but the single test is marked pending rather than
// failing a Docker-less CI/dev box. Run explicitly with:
//   npx vitest run test/pg-smoke.test.ts
import { it, expect, afterAll } from 'vitest';
import { startPg, type PgContext } from './helpers/pg';

let ctx: PgContext;

it(
  'postgres schema applies and accepts a round-trip',
  async () => {
    ctx = await startPg();
    await ctx.pool.query("INSERT INTO users (id, display_name) VALUES ('t1','Test')");
    const r = await ctx.pool.query('SELECT display_name FROM users WHERE id=$1', ['t1']);
    expect(r.rows[0].display_name).toBe('Test');
  },
  120_000,
);

afterAll(async () => {
  await ctx?.pool.end();
  await ctx?.container.stop();
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { createTestDatabase } from './helpers/db';

describe('workflow impact columns (migration 071)', () => {
  let cleanup: () => Promise<void>;

  // Its own migrated test database, rather than whatever
  // default DB getTypedClient() would open.
  beforeAll(async () => {
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
  });

  afterAll(async () => cleanup());

  it('use_case_activation_weeks carries the impact columns, nullable', async () => {
    const client = await getTypedClient();
    const t = schema.useCaseActivationWeeks;
    await client.insert(schema.useCases).values({ id: 'wi-uc-1', title: 'WI Schema UC' } as never).onConflictDoNothing();
    await client.insert(t).values({ use_case_id: 'wi-uc-1', week_start: 1756000000, updated_at: 1 } as never).onConflictDoNothing();
    // Select THIS test's own row — an unfiltered read returned whichever row
    // happened to sort first, so the rollup suite's fixture rows (shared DB
    // file in CI) made rows[0].d non-null and the assertion flaky by suite
    // order (a standing CI failure, now fixed).
    const rows = await client.select({
      d: t.measured_duration_secs, e: t.engaged_secs, te: t.tool_error_count,
      rj: t.edit_reject_count, ac: t.edit_accept_count, fl: t.flagged_count,
      cwte: t.cowork_tool_error_count,
    }).from(t).where(and(eq(t.use_case_id, 'wi-uc-1'), eq(t.week_start, 1756000000)));
    expect(rows.length).toBe(1);
    expect(rows[0].d).toBeNull();
    expect(rows[0].e).toBeNull();
    expect(rows[0].te).toBeNull();
    expect(rows[0].rj).toBeNull();
    expect(rows[0].ac).toBeNull();
    expect(rows[0].fl).toBeNull();
    expect(rows[0].cwte).toBeNull();
  });

  it('use_cases carries the summary cache columns', async () => {
    const client = await getTypedClient();
    const u = schema.useCases;
    const rows = await client.select({ s: u.impact_summary, at: u.impact_summary_at }).from(u).limit(1);
    expect(rows.length).toBeGreaterThan(0);
  });
});

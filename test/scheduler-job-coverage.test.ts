// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Every scheduled job must run through runJob (lib/ingestion/job-runs.ts) so
// its success or failure is recorded in job_runs. A bare try/catch in the cycle
// would bring back the silent-failure mode.
// Static check over the scheduler source — no database.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JOB_CATALOG } from '@/lib/health/job-catalog';

const src = readFileSync(join(__dirname, '..', 'lib', 'ingestion', 'scheduler.ts'), 'utf8');
const cycle = src.slice(src.indexOf('async function runCycle('), src.indexOf('// Schedule next cycle'));

describe('scheduler job coverage', () => {
  it('runCycle has no bare try/catch — every job goes through runJob', () => {
    expect(cycle.length).toBeGreaterThan(1000);
    expect(cycle).not.toMatch(/\btry\s*\{/);
    expect(cycle).not.toMatch(/console\.error\('\[Scheduler\]/);
  });

  it('job names are unique snake_case identifiers', () => {
    const names = [...cycle.matchAll(/runJob\('([^']+)'/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(22);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('the System health panel catalogue lists exactly the scheduler jobs, in order', () => {
    const names = [...cycle.matchAll(/runJob\('([^']+)'/g)].map(m => m[1]);
    expect(JOB_CATALOG.map(j => j.name)).toEqual(names);
  });
});

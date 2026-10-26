// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for /api/pulse/code/classifier's
// extended GET (rubric config + defaults + promptPreview) and the new POST
// save-rubric action (validate → persist config → clear all
// code_session_classifications rows so Pass 1's NO-EXISTING-ROW candidate
// query re-classifies every ended session under the new rubric).
//
// GET now also serves the classifier-health
// payload (queue/tierDistribution/confidenceHistogram/currentFailures) and
// drops promptPreview from GET; POST run-now is a bounded drain that returns
// `remaining`. runCodeClassifierJob is mocked so the drain terminates
// deterministically without a real Anthropic call.
//
// Harness mirrors test/pulse-admin-routes-pg.test.ts: one runSpec() run
// against a migrated Postgres database (the shared test server when
// CCC_TEST_PG_URL is set, else a testcontainer). Admin-auth is mocked.
//
// Seed note: code_session_classifications.session_id carries a REAL FK to
// code_session_stats(session_id) (migration 029, schema.pg.ts), enforced by
// Postgres. So the seed
// below inserts the parent code_session_stats rows FIRST (its own NOT-NULL,
// no-default columns are session_id/first_at/last_at/computed_at); a seed
// that skipped this would fail with an FK violation on insert.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Stateful mock: first call reports work (classified 2), every call after
// reports nothing — lets the bounded drain in POST run-now terminate after
// exactly 2 passes without a real Anthropic call.
let runNowCallCount = 0;
vi.mock('@/lib/pulse/code/classifier', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/code/classifier')>();
  return {
    ...actual,
    runCodeClassifierJob: vi.fn(async () => {
      runNowCallCount++;
      return runNowCallCount === 1
        ? { selected: 2, classified: 2, failed: 0 }
        : { selected: 0, classified: 0, failed: 0 };
    }),
  };
});

const mockSession: { authenticated: boolean; role?: string; email?: string } = {
  authenticated: true,
  role: 'admin',
  email: 'admin@test.com',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/admin-auth')>()),
  getAdminSession: async () => mockSession,
}));

function req(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

const NOW = Math.floor(Date.now() / 1000);

async function runSpec(): Promise<void> {
  runNowCallCount = 0; // reset the stateful runCodeClassifierJob mock
  const h = await (await import('./helpers/db')).createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;
  try {
    const { schema } = await import('@/lib/db/schema');

    // Parent rows: code_session_stats FK target for code_session_classifications.session_id.
    await client.insert(schema.codeSessionStats).values([
      { session_id: 's1', user_id: 'u1', first_at: NOW, last_at: NOW, computed_at: NOW },
      { session_id: 's2', user_id: 'u1', first_at: NOW, last_at: NOW, computed_at: NOW },
    ]);

    // seed 2 classified sessions
    await client.insert(schema.codeSessionClassifications).values([
      { session_id: 's1', user_id: 'u1', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'haiku', status: 'classified', classified_at: NOW, provisional: 0 },
      { session_id: 's2', user_id: 'u1', work_type: 'bugfix',  tier: 1, confidence: 0.8, classifier_model: 'haiku', status: 'classified', classified_at: NOW, provisional: 0 },
    ]);
    const { GET, POST } = await import('../app/api/pulse/code/classifier/route');

    // GET returns config + defaults
    const g = await (await GET(req('/api/pulse/code/classifier'))).json();
    expect(g.config).toBeTruthy();
    expect(g.defaults).toBeTruthy();
    expect(g.config.tiers.tier1.description).toContain('single-step');

    // GET also serves the classifier-health payload and no longer
    // builds a server-side prompt preview (the rubric tab builds it client-side).
    expect(g).toHaveProperty('queue.total');
    expect(g).toHaveProperty('tierDistribution');
    expect(g).toHaveProperty('confidenceHistogram');
    expect(Array.isArray(g.currentFailures)).toBe(true);
    expect(g).not.toHaveProperty('promptPreview');
    expect(g.classified).toBe(2); // the 2 seeded classified rows
    expect(g.tierDistribution.tier2).toBe(1); // s1
    expect(g.tierDistribution.tier1).toBe(1); // s2

    // POST run-now drains (mocked runCodeClassifierJob: pass 1 classifies 2,
    // pass 2 reports 0 and the loop stops) and returns remaining queue depth.
    const runNowRes = await POST(req('/api/pulse/code/classifier', { method: 'POST', body: JSON.stringify({ action: 'run-now' }) }));
    expect(runNowRes.status).toBe(200);
    const runNowBody = await runNowRes.json();
    expect(runNowBody.ok).toBe(true);
    expect(runNowBody.classified).toBe(2);
    expect(runNowBody.failed).toBe(0);
    expect(runNowBody).toHaveProperty('remaining');
    expect(typeof runNowBody.remaining).toBe('number');

    // POST save-rubric persists and applies going forward only — nothing cleared
    const cfg = structuredClone(g.defaults);
    cfg.tiers.tier2.name = 'Custom';
    const saveRes = await POST(req('/api/pulse/code/classifier', { method: 'POST', body: JSON.stringify({ action: 'save-rubric', config: cfg }) }));
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody.ok).toBe(true);
    expect(saveBody.reclassifyCleared).toBeUndefined();
    // existing classifications kept
    const remaining = await client.select({ c: (await import('drizzle-orm')).sql`count(*)` }).from(schema.codeSessionClassifications);
    expect(Number(remaining[0].c)).toBe(2);
    // config persisted + reflected on GET
    const g2 = await (await GET(req('/api/pulse/code/classifier'))).json();
    expect(g2.config.tiers.tier2.name).toBe('Custom');

    // bad body → 400
    const bad = await POST(req('/api/pulse/code/classifier', { method: 'POST', body: JSON.stringify({ action: 'save-rubric', config: { tiers: {} } }) }));
    expect(bad.status).toBe(400);

    // blank-name work type element → 400, config unchanged (no persist)
    const blankNameCfg = structuredClone(g.defaults);
    blankNameCfg.workTypes[0].name = '   ';
    const blankNameRes = await POST(req('/api/pulse/code/classifier', { method: 'POST', body: JSON.stringify({ action: 'save-rubric', config: blankNameCfg }) }));
    expect(blankNameRes.status).toBe(400);
    const blankNameBody = await blankNameRes.json();
    expect(blankNameBody.error).toBeTruthy();
    const gAfterBlank = await (await GET(req('/api/pulse/code/classifier'))).json();
    expect(gAfterBlank.config.tiers.tier2.name).toBe('Custom'); // still the earlier successful save, unchanged
  } finally {
    await cleanup();
  }
}

describe('code classifier route (postgres)', () => {
  it('config get + save-rubric reclassify on real postgres', async () => {
    await runSpec();
  }, 180_000);
});

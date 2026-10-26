// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for the /api/pulse/admin/health
// and /api/pulse/admin/tiers route handlers' OWN inline queries (async
// Drizzle). Proves on REAL Postgres:
//   - The classifier candidate-set NOT-IN-subquery queueDepth count is
//     correct (a 'failed' row with attempts below MAX_ATTEMPTS still counts
//     as queued; a classified row and a permanently-failed row do not).
//   - The day-bucket GROUP BY (to_char(...) AT TIME ZONE 'UTC' vs
//     strftime) groups classified rows into the correct {day, tier, cnt}
//     buckets, COUNT() coerced from a pg bigint/string to a JS number.
//   - The confidence-histogram GROUP BY (grouping by the SELECT output alias
//     `bucket`, a Postgres extension) buckets classifier_confidence*10
//     correctly.
//   - The failures JOIN (pulse_classifications ⋈ cowork_messages ⋈ users)
//     surfaces only 'failed' rows with the joined content_preview/display_name.
//   - The modelLog GROUP BY MIN/MAX/COUNT aggregate (unfiltered by status —
//     failed rows count too) coerces bigint/COUNT correctly.
//   - POST /health deletes only 'failed' rows and returns the
//     rowsAffected() count.
//   - POST /tiers performs its ON-CONFLICT-free write path (config upsert +
//     version-history INSERT + reclassify UPDATE) correctly:
//     the saved config round-trips via GET, a pulse_rubric_versions snapshot
//     row is written, and every 'classified' row flips to 'unclassified'
//     (saving no longer resets classifications).
//
// Harness mirrors test/pulse-routes-pg.test.ts: one runSpec() against a
// migrated Postgres database (createTestDbClient('postgres') — the shared
// server at CCC_TEST_PG_URL, or a postgres:16 testcontainer). Admin-auth is
// mocked; everything else hits the REAL database via a fresh dynamic import
// (every module under test is imported AFTER the database env is established).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string } = {
  authenticated: true,
  role: 'admin',
  email: 'admin@test.com',
  userId: 'admin1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

function makeRequest(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');

    // ── Users ──
    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper' },
    ]);

    // ── cowork_messages: 4 user messages —
    //   cm1 (u1, classified tier1), cm2 (u1, classified tier2),
    //   cm3 (u2, unclassified — counts toward queueDepth),
    //   cm4 (u2, failed classification with attempts < MAX — also counts) ──
    await client.insert(schema.coworkMessages).values([
      { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'draft the report', occurred_at: NOW - DAY },
      { id: 'cm2', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'multi-step workflow', occurred_at: NOW - 2 * DAY },
      { id: 'cm3', session_id: 's2', user_id: 'u2', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'not yet classified', occurred_at: NOW - DAY },
      { id: 'cm4', session_id: 's2', user_id: 'u2', message_type: 'cowork_user_message', surface: 'cowork', content_preview: 'errored classification', occurred_at: NOW - DAY },
    ]);

    await client.insert(schema.pulseClassifications).values([
      { cowork_message_id: 'cm1', user_id: 'u1', tier: 1, task_type: 'basic_drafting', classifier_confidence: 0.93, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - DAY },
      { cowork_message_id: 'cm2', user_id: 'u1', tier: 2, task_type: 'coding', classifier_confidence: 0.81, classifier_model: 'haiku', classifier_status: 'classified', classified_at: NOW - 2 * DAY },
      { cowork_message_id: 'cm4', user_id: 'u2', tier: 1, task_type: 'basic_drafting', classifier_confidence: 0.5, classifier_model: 'haiku', classifier_status: 'failed', classifier_attempts: 2, classifier_error: 'API timeout', classified_at: NOW - DAY },
    ]);

    // ═══════════════════════════ GET /api/pulse/admin/health ═══════════════════════════
    const { GET: healthGET, POST: healthPOST } = await import('../app/api/pulse/admin/health/route');
    const healthRes = await healthGET(makeRequest('/api/pulse/admin/health'));
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();

    // cm3 (unclassified) + cm4 (failed, attempts=2 < MAX_ATTEMPTS=5) both queued.
    expect(healthBody.queueDepth).toBe(2);
    expect(typeof healthBody.queueDepth).toBe('number');

    // Day-bucket GROUP BY: cm1 (tier1, NOW-1d) and cm2 (tier2, NOW-2d) land on
    // different days — 2 distinct {day, tier} buckets, each count 1.
    expect(healthBody.tierDist).toHaveLength(2);
    for (const row of healthBody.tierDist) {
      expect(typeof row.cnt).toBe('number');
      expect(row.cnt).toBe(1);
    }
    expect(healthBody.tierDist.map((r: { tier: number }) => r.tier).sort()).toEqual([1, 2]);

    // Confidence histogram: 0.93*10=9.3→9, 0.81*10=8.1→8 (the failed row is
    // excluded — WHERE classifier_status = 'classified').
    expect(healthBody.confidenceHist).toHaveLength(2);
    expect(healthBody.confidenceHist.map((r: { bucket: number }) => r.bucket).sort()).toEqual([8, 9]);
    for (const row of healthBody.confidenceHist) {
      expect(typeof row.cnt).toBe('number');
      expect(row.cnt).toBe(1);
    }

    // Failures JOIN — only the 'failed' cm4 row, joined to content_preview + display_name.
    expect(healthBody.failures).toHaveLength(1);
    expect(healthBody.failures[0].content_preview).toBe('errored classification');
    expect(healthBody.failures[0].display_name).toBe('Grace Hopper');
    expect(healthBody.failures[0].classifier_error).toBe('API timeout');

    // modelLog — unfiltered by status, so all 3 rows count under 'haiku'.
    expect(healthBody.modelLog).toHaveLength(1);
    expect(healthBody.modelLog[0].classifier_model).toBe('haiku');
    expect(healthBody.modelLog[0].total_classified).toBe(3);
    expect(typeof healthBody.modelLog[0].total_classified).toBe('number');
    expect(healthBody.modelLog[0].first_used).toBe(NOW - 2 * DAY);
    expect(healthBody.modelLog[0].last_used).toBe(NOW - DAY);

    // ═══════════════════════════ POST /api/pulse/admin/health (retry failed) ═══════════════════════════
    const healthPostRes = await healthPOST(makeRequest('/api/pulse/admin/health', { method: 'POST' }));
    expect(healthPostRes.status).toBe(200);
    const healthPostBody = await healthPostRes.json();
    expect(healthPostBody.retried).toBe(1);
    expect(typeof healthPostBody.retried).toBe('number');

    // The failed row is gone — a second run retries 0.
    const healthPostRes2 = await healthPOST(makeRequest('/api/pulse/admin/health', { method: 'POST' }));
    const healthPostBody2 = await healthPostRes2.json();
    expect(healthPostBody2.retried).toBe(0);

    // ═══════════════════════════ POST /api/pulse/admin/tiers (write) ═══════════════════════════
    const { GET: tiersGET, POST: tiersPOST } = await import('../app/api/pulse/admin/tiers/route');
    const { DEFAULT_TIER_CONFIG } = await import('@/lib/pulse/tier-config');

    const customConfig = {
      ...DEFAULT_TIER_CONFIG,
      confidenceThreshold: 0.65,
      tiers: {
        ...DEFAULT_TIER_CONFIG.tiers,
        tier1: { ...DEFAULT_TIER_CONFIG.tiers.tier1, name: 'Custom Tier One' },
      },
    };

    const tiersPostRes = await tiersPOST(makeRequest('/api/pulse/admin/tiers', {
      method: 'POST',
      body: JSON.stringify({ config: customConfig }),
    }));
    expect(tiersPostRes.status).toBe(200);
    const tiersPostBody = await tiersPostRes.json();
    expect(tiersPostBody.ok).toBe(true);
    // Saving applies going forward only: nothing is reset.
    expect(tiersPostBody.reclassifyTriggered).toBeUndefined();

    // Config round-trips via GET.
    const tiersGetRes = await tiersGET(makeRequest('/api/pulse/admin/tiers'));
    const tiersGetBody = await tiersGetRes.json();
    expect(tiersGetBody.config.confidenceThreshold).toBe(0.65);
    expect(tiersGetBody.config.tiers.tier1.name).toBe('Custom Tier One');

    // Version-history snapshot was written.
    const { eq } = await import('drizzle-orm');
    const versionRows = await client
      .select({ changed_by: schema.pulseRubricVersions.changed_by, rubric_json: schema.pulseRubricVersions.rubric_json })
      .from(schema.pulseRubricVersions);
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0].changed_by).toBe('admin@test.com');
    expect(JSON.parse(versionRows[0].rubric_json).confidenceThreshold).toBe(0.65);

    // No reset — the previously-'classified' cm1 row keeps its classification,
    // so Work Mix and the other cards never empty on a save.
    const cm1Rows = await client
      .select({ classifier_status: schema.pulseClassifications.classifier_status })
      .from(schema.pulseClassifications)
      .where(eq(schema.pulseClassifications.cowork_message_id, 'cm1'));
    expect(cm1Rows[0].classifier_status).toBe('classified');
  } finally {
    await cleanup();
  }
}

describe('pulse admin health/tiers routes (postgres)', () => {
  it(
    'return correctly-aggregated JSON with NOT-IN/day-bucket/GROUP-BY-alias coercion and ON-CONFLICT-free upserts correct on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

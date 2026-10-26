// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Developer Pulse "derived" modules:
// lib/pulse/code/dept.ts, lib/pulse/code/lift.ts, lib/pulse/code/github-sync.ts,
// and lib/pulse/code/briefing.ts.
//
// Runs against a migrated Postgres database (the shared test server when
// CCC_TEST_PG_URL is set, else a testcontainer).
//
// HARNESS RULE (copied from test/code-pulse-aggregator-classifier-pg.test.ts):
// these modules import `schema` from lib/db/schema.ts, and the database client binds to DATABASE_URL on
// first use, so the modules-under-test (and schema) are DYNAMIC-imported
// AFTER createTestDbClient() has set DATABASE_URL + reset modules.
//
// Coverage:
//   1. getCodeDeptMembers returns the FULL roster (membership-first) incl. a
//      member with no code_metrics row (zero/blank) — the
//      deliberate fix this module exists to preserve.
//   2. getCodeDeptMembers's department match is case-SENSITIVE (`=`, not
//      LIKE).
//   3. runGithubSync upserts github_repo_stats correctly (mock `fetch` — never
//      hits the real GitHub API), including the ON CONFLICT(repo,date) update
//      path on a re-run.
//   4. A briefing generate/read round-trip (mocked Anthropic SDK), proving the
//      Number()-coercion of the Postgres bigint/numeric aggregate reads in
//      buildDataSummary() doesn't corrupt the written body.
//   5. computeObservedLift's plain filtered SELECT over code_metrics.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

const NOW = Math.floor(Date.now() / 1000);

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function mockFetchSequence(responses: Array<{ ok: boolean; json: unknown; linkHeader?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      headers: { get: (name: string) => (name.toLowerCase() === 'link' ? (r.linkHeader ?? null) : null) },
      json: async () => r.json,
    };
  });
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // Dynamic import AFTER the env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const dept = await import('@/lib/pulse/code/dept');
    const lift = await import('@/lib/pulse/code/lift');
    const githubSync = await import('@/lib/pulse/code/github-sync');
    const briefing = await import('@/lib/pulse/code/briefing');
    const config = await import('@/lib/config');
    const { weekStarts } = await import('@/lib/pulse/period');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ── (1)+(2): getCodeDeptMembers — full roster + case-sensitive match ────
    const DEPT = 'AppliedAI';
    await db.insert(schema.users).values([
      { id: 'u1', email: 'u1@applied.test', display_name: 'U1', department: DEPT },
      { id: 'u2', email: 'u2@applied.test', display_name: 'U2', department: DEPT },
      { id: 'u5', email: 'u5@applied.test', display_name: 'U5', department: null },
    ]);
    await db.insert(schema.adminUsers).values([
      { id: 'a5', email: 'u5@applied.test', password_hash: 'x', display_name: 'U5', role: 'pulse', department: DEPT, linked_cowork_user_id: 'u5' },
    ]);
    await db.insert(schema.codeMetrics).values({
      scope_type: 'user', scope_id: 'u1', period_start: 0, period_end: 0,
      spend_usd: '42.5', session_count: 7, commit_count: 3, granularity: 'rolling', computed_at: NOW,
    });

    const members = await dept.getCodeDeptMembers(DEPT);
    // Full roster: u1 (active), u2 (no metrics), u5 (admin_users-only path) — 3 members.
    expect(members).toHaveLength(3);
    const u1 = members.find(m => m.user_id === 'u1')!;
    expect(Number(u1.spend_usd)).toBeCloseTo(42.5, 6);
    expect(u1.session_count).toBe(7);
    const u2 = members.find(m => m.user_id === 'u2')!;
    expect(u2.spend_usd).toBeNull();
    expect(u2.session_count).toBe(0);
    expect(members.some(m => m.user_id === 'u5')).toBe(true);

    // Case-sensitive equality (plain `=`, never LIKE).
    const wrongCase = await dept.getCodeDeptMembers(DEPT.toLowerCase());
    expect(wrongCase).toHaveLength(0);

    // ── (5): computeObservedLift — plain filtered SELECT over code_metrics ──
    await db.delete(schema.codeMetrics);
    const weeks = weekStarts(NOW, 9);
    const completed = weeks.slice(0, 8);
    for (let i = 0; i < completed.length; i++) {
      const isHigh = i >= 4;
      await db.insert(schema.codeMetrics).values({
        scope_type: 'organisation', scope_id: 'org', period_start: completed[i], period_end: completed[i] + 1,
        active_time_user_s: isHigh ? 5000 : 1000, commit_count: isHigh ? 10 : 8,
        granularity: 'week', computed_at: NOW,
      });
    }
    const observedLift = await lift.computeObservedLift();
    expect(observedLift).not.toBeNull();
    expect(observedLift!.liftPct).toBeCloseTo(0.25, 5);

    // ── (3): runGithubSync — upsert fidelity + re-run updates, mocked fetch ──
    await db.insert(schema.githubRepoMap).values({ repo: 'my-app', github_repo: 'org/my-app' });
    const today = new Date().toISOString().slice(0, 10);
    const commitIso = `${today}T12:00:00Z`;
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence([
      { ok: true, json: [{ commit: { committer: { date: commitIso } } }] }, // commits page 1
      { ok: true, json: [{ merged_at: commitIso }] }, // merged PRs
    ]) as unknown as typeof fetch;
    try {
      const result1 = await githubSync.runGithubSync();
      expect(result1).toEqual({ synced: 1, failed: 0, errors: [] });
      const statsRows1 = await db.select().from(schema.githubRepoStats);
      const row1 = statsRows1.find((r: { date: string }) => r.date === today);
      expect(row1.commit_count).toBe(1);
      expect(row1.prs_merged).toBe(1);

      // Re-run with different counts. The full-window DELETE-then-INSERT
      // design means a same-day re-sync never hits the ON CONFLICT arbiter
      // in practice (it's a defensive no-duplicate-row guarantee inherited
      // unchanged from the pre-image); this proves the OVERALL re-sync is
      // idempotent — exactly one row for today's date, with fresh counts.
      global.fetch = mockFetchSequence([
        { ok: true, json: [{ commit: { committer: { date: commitIso } } }, { commit: { committer: { date: commitIso } } }] },
        { ok: true, json: [] },
      ]) as unknown as typeof fetch;
      const result2 = await githubSync.runGithubSync();
      expect(result2).toEqual({ synced: 1, failed: 0, errors: [] });
      const statsRows2 = await db.select().from(schema.githubRepoStats);
      const rowsForToday = statsRows2.filter((r: { date: string }) => r.date === today);
      expect(rowsForToday).toHaveLength(1); // upserted, not duplicated
      expect(rowsForToday[0].commit_count).toBe(2);
      expect(rowsForToday[0].prs_merged).toBe(0);

      const mappings = await githubSync.getMappings();
      expect(mappings).toEqual([{ repo: 'my-app', github_repo: 'org/my-app' }]);
    } finally {
      global.fetch = originalFetch;
    }

    // ── (4): briefing generate/read round-trip ───────────────────────────────
    await db.delete(schema.codeMetrics);
    await db.insert(schema.codeMetrics).values({
      scope_type: 'organisation', scope_id: 'org', period_start: NOW - 7 * 24 * 3600, period_end: NOW,
      spend_usd: '12.5', session_count: 4, repo_count: 2, commit_count: 6,
      autonomy_ratio: 1.5, cache_hit_ratio: 0.4, input_tokens: 1000, output_tokens: 500,
      granularity: 'rolling', computed_at: NOW,
    });
    await config.setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ paragraphs: ['p1', 'p2', 'p3'], suggestion: 'do the thing' }) }],
    });

    const generated = await briefing.generateCodeBriefing();
    expect(generated.body).toBe('p1\n\np2\n\np3');
    expect(generated.suggestion).toBe('do the thing');

    const latest = await briefing.getLatestCodeBriefing();
    expect(latest).not.toBeNull();
    expect(latest!.body).toBe(generated.body);
    expect(latest!.suggestion).toBe('do the thing');
    expect(latest!.generated_at).toBe(generated.generated_at);
  } finally {
    await cleanup();
  }
}

describe('Developer Pulse derived modules — dept/lift/github-sync/briefing (postgres)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

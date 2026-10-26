// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for these lib/pulse/** modules:
// trends.ts, stickiness.ts, mcp-classify.ts, briefings/cio.ts,
// skills-discover.ts, against a migrated Postgres database
// (createTestDbClient('postgres')).
//
// HARNESS RULE (copied from pulse-metrics-events-pg.test.ts): modules-under-
// test (and schema) are DYNAMIC-imported AFTER createTestDbClient() has set
// the database env + reset modules.
import { describe, it, expect, vi } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// A single mocked Anthropic client backs BOTH generateCioBriefing (no tools,
// expects a {paragraphs, named_risk, recommendation} JSON object) AND
// runSkillsDiscover (passes a web_search tool, expects an end_turn response
// with a JSON ARRAY) — branch on whether `tools` was passed.
interface MockCreateParams { tools?: unknown[] }
const mockCreate = vi.fn().mockImplementation((params: MockCreateParams) => {
  if (params.tools) {
    return Promise.resolve({
      stop_reason: 'end_turn',
      content: [{
        type: 'text',
        text: JSON.stringify([
          { name: 'test-skill', description: 'A test skill.', source_url: 'https://example.com', category: 'skill', published_at: null },
        ]),
      }],
    });
  }
  return Promise.resolve({
    content: [{
      type: 'text',
      text: JSON.stringify({
        paragraphs: ['Org para one.', 'Org para two.', 'Org para three.'],
        named_risk: 'Concentration on one team',
        recommendation: 'Cross-train adjacent teams',
      }),
    }],
  });
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the database env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const trends = await import('@/lib/pulse/trends');
    const stickiness = await import('@/lib/pulse/stickiness');
    const mcpClassify = await import('@/lib/pulse/mcp-classify');
    const cio = await import('@/lib/pulse/briefings/cio');
    const skillsDiscover = await import('@/lib/pulse/skills-discover');
    const configLib = await import('@/lib/config');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ── (1) getWeeklySeries / getWeeklyDelta — completed vs partial weeks ────
    const { weekStarts, weekStart } = await import('@/lib/pulse/period');
    const weeks = weekStarts(NOW, 4);
    const priorWeekStart = weeks[2];
    const currentWeekStart = weeks[3];

    await db.insert(schema.codeMetrics).values([
      {
        scope_type: 'organisation', scope_id: 'org', period_start: priorWeekStart, period_end: priorWeekStart + 1,
        spend_usd: '100', granularity: 'week', computed_at: NOW,
      },
      {
        scope_type: 'organisation', scope_id: 'org', period_start: currentWeekStart, period_end: currentWeekStart + 1,
        spend_usd: '999', granularity: 'rolling', computed_at: NOW, // decoy rolling row
      },
    ]);

    const series = await trends.getWeeklySeries('code_metrics', 'organisation', 'org', 'spend_usd', 4);
    expect(series).toHaveLength(4);
    expect(series[2].value).toBe(100);
    expect(series[2].partial).toBe(false);
    expect(series[3].value).toBeNull(); // decoy rolling row must never surface
    expect(series[3].partial).toBe(true);
    expect(series[3].weekStart).toBe(weekStart(NOW));

    const delta = await trends.getWeeklyDelta('code_metrics', 'organisation', 'org', 'spend_usd', 4);
    expect(delta.current).toBe(100);
    expect(delta.prior).toBeNull();
    expect(delta.pct).toBeNull();

    // ── (2) getProductStickiness — DAU/MAU with a UTC day-bucket ─────────────
    await db.insert(schema.users).values([{ id: 'stick-1' }, { id: 'stick-2' }]);
    await db.insert(schema.coworkMessages).values([
      { id: 'stick-m1', session_id: 'sess-1', user_id: 'stick-1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 1 * DAY },
      { id: 'stick-m2', session_id: 'sess-2', user_id: 'stick-2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - 1 * DAY },
    ]);
    const stick = await stickiness.getProductStickiness(NOW);
    expect(stick.cowork.mau).toBe(2);
    // Both users active on the same single (UTC) day within the trailing 7
    // complete days -> 2 user-days / 7.
    expect(stick.cowork.avgDau).toBeCloseTo(2 / 7, 5);
    // stickiness = avgDau / mau = (2/7) / 2 = 1/7.
    expect(stick.cowork.stickiness).toBeCloseTo(1 / 7, 2);

    // ── (3) getConnectorReadWriteCounts ──────────────────────────────────────
    await db.insert(schema.coworkMcpInvocations).values([
      { id: 'mcp-1', user_id: 'stick-1', session_id: 'sess-1', mcp_server: 'github', mcp_tool: 'search_repos', occurred_at: NOW },
      // Distinct occurred_at from mcp-1: (session_id, mcp_server, mcp_tool,
      // occurred_at) has a real unique dedup index.
      { id: 'mcp-2', user_id: 'stick-1', session_id: 'sess-1', mcp_server: 'github', mcp_tool: 'search_repos', occurred_at: NOW + 1 },
      { id: 'mcp-3', user_id: 'stick-2', session_id: 'sess-2', mcp_server: 'github', mcp_tool: 'create_issue', occurred_at: NOW },
    ]);
    const rw = await mcpClassify.getConnectorReadWriteCounts();
    expect(rw.get('github')).toEqual({ reads: 2, writes: 1 });

    // ── (4) A briefing generate/read round-trip (CIO org briefing) ──────────
    const msgId = 'cio-msg-1';
    await db.insert(schema.coworkMessages).values({
      id: msgId, session_id: 'cio-sess-1', user_id: 'stick-1', message_type: 'cowork_user_message', occurred_at: NOW - 1000,
    });
    await db.insert(schema.pulseClassifications).values({
      cowork_message_id: msgId, user_id: 'stick-1', tier: 2, task_type: 'analytics',
      classifier_confidence: 0.9, classifier_model: 'test-model', classifier_status: 'classified',
      classified_at: NOW - 1000,
    });

    // ── (4a) Concentration-risk regression fixture ────────
    // A GROUP BY bug was caught in cio.ts's raw "concentration
    // risk" subquery: the inner query groups by task_type only (to test
    // "exactly one distinct user touched this Tier-3 task type"), so
    // user_id has to be wrapped in MAX() to satisfy Postgres's strict
    // GROUP BY. No existing test drove concentration_risk_count above 0,
    // so a regression that reintroduces the naive query
    // (e.g. `GROUP BY task_type, user_id` instead of `MAX(user_id)` +
    // `GROUP BY task_type`) would pass silently -- that naive form makes
    // `COUNT(DISTINCT user_id) = 1` trivially true for every row (each
    // inner group already has exactly one user_id by construction),
    // silently defeating the "sole owner" filter.
    //
    // Seed two users:
    //   - 'conc-sole-owner': sole Tier-3 owner of 3 distinct task types
    //     -> MUST be counted (concentration_risk_count includes them).
    //   - 'conc-partial-owner': sole owner of only 2 Tier-3 task types,
    //     plus a 3rd task type SHARED with 'conc-other-user' -> must NOT
    //     be counted. The correct query excludes the shared type via the
    //     inner HAVING (two distinct users touched it), leaving
    //     partial-owner's sole count at 2 (< 3). The broken/naive query
    //     would let the shared type through, inflating partial-owner to a
    //     false sole_count of 3 and incorrectly flagging them too -- this
    //     is exactly the failure this fixture locks out.
    await db.insert(schema.users).values([
      { id: 'conc-sole-owner' }, { id: 'conc-partial-owner' }, { id: 'conc-other-user' },
    ]);
    const concRows: Array<{ id: string; user_id: string; task_type: string }> = [
      { id: 'conc-msg-1', user_id: 'conc-sole-owner', task_type: 'audit_review' },
      { id: 'conc-msg-2', user_id: 'conc-sole-owner', task_type: 'model_governance' },
      { id: 'conc-msg-3', user_id: 'conc-sole-owner', task_type: 'vendor_risk' },
      { id: 'conc-msg-4', user_id: 'conc-partial-owner', task_type: 'partial_a' },
      { id: 'conc-msg-5', user_id: 'conc-partial-owner', task_type: 'partial_b' },
      { id: 'conc-msg-6', user_id: 'conc-partial-owner', task_type: 'shared_task' },
      { id: 'conc-msg-7', user_id: 'conc-other-user', task_type: 'shared_task' },
    ];
    await db.insert(schema.coworkMessages).values(concRows.map(r => ({
      id: r.id, session_id: 'conc-sess', user_id: r.user_id, message_type: 'cowork_user_message', occurred_at: NOW - 500,
    })));
    await db.insert(schema.pulseClassifications).values(concRows.map(r => ({
      cowork_message_id: r.id, user_id: r.user_id, tier: 3, task_type: r.task_type,
      classifier_confidence: 0.9, classifier_model: 'test-model', classifier_status: 'classified',
      classified_at: NOW - 500,
    })));

    await configLib.setConfigValue('anthropicAiApiKey', 'test-ai-key');

    const periodStart = NOW - 30 * DAY;
    const periodEnd = NOW;
    const body = await cio.generateCioBriefing(periodStart, periodEnd, 'claude-haiku-4-5-20251001');
    expect(body).toContain('Org para one.');

    const briefingRows = await db.select().from(schema.pulseBriefings) as Array<{
      scope_type: string; scope_id: string; body: string;
    }>;
    expect(briefingRows).toHaveLength(1);
    expect(briefingRows[0].scope_type).toBe('organisation');
    expect(briefingRows[0].scope_id).toBe('org');
    expect(briefingRows[0].body).toContain('Org para one.');

    // generateCioBriefing doesn't return the raw ctx, but
    // buildCioBriefingUserMessage embeds the exact concentration_risk_count
    // in the RESILIENCE section of the prompt sent to the (mocked)
    // Anthropic call -- inspecting that captured prompt locks the SQL
    // result without needing any production-code change.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cioCallArgs = mockCreate.mock.calls.at(-1)?.[0] as any;
    const userPrompt: string = cioCallArgs.messages[0].content;
    // Positive case: exactly 'conc-sole-owner' counted (count === 1).
    expect(userPrompt).toContain(
      '1 user(s) are sole runners of 3 or more Tier 3 workflows, so concentration risk is present.'
    );
    // Negative/boundary case: 'conc-partial-owner' must NOT also be
    // counted -- a naive GROUP BY that defeats the sole-owner HAVING
    // filter would inflate this to 2.
    expect(userPrompt).not.toContain('2 user(s) are sole runners');

    // ── (4b) Negative case: no Tier-3 activity in period -> count is 0 ───────
    const emptyPeriodStart = NOW - 400 * DAY;
    const emptyPeriodEnd = NOW - 200 * DAY;
    await cio.generateCioBriefing(emptyPeriodStart, emptyPeriodEnd, 'claude-haiku-4-5-20251001');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cioCallArgs2 = mockCreate.mock.calls.at(-1)?.[0] as any;
    const userPrompt2: string = cioCallArgs2.messages[0].content;
    expect(userPrompt2).toContain('No concentration risk detected.');

    const briefingRowsAfterSecondCall = await db.select().from(schema.pulseBriefings);
    expect(briefingRowsAfterSecondCall).toHaveLength(2);

    // ── (5) skills-discover cache write + read (proving the unixepoch replacement) ─
    const before = await skillsDiscover.getDiscoverCache();
    expect(before.items).toEqual([]);
    expect(before.cached_at).toBeNull();
    expect(before.is_stale).toBe(true);

    const items = await skillsDiscover.runSkillsDiscover();
    expect(Array.isArray(items)).toBe(true);

    const after = await skillsDiscover.getDiscoverCache();
    expect(after.cached_at).not.toBeNull();
    expect(after.is_stale).toBe(false);
  } finally {
    await cleanup();
  }
}

describe('pulse trends + stickiness + mcp-classify + cio briefing + skills-discover (postgres)', () => {
  it(
    'behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

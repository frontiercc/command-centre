// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse's per-vendor figures: the hourly aggregator saves Claude and
// OpenAI figures to pulse_metrics_vendor while OpenAI data exists, and leaves
// the all-products figures in pulse_metrics as they were. POSTGRES ONLY.
import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
}));

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'me@example.org' }) };
});

async function cio(vendor: string) {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../app/api/pulse/cio/route');
  const res = await GET(new NextRequest(`http://localhost/api/pulse/cio?vendor=${vendor}`));
  return res.json();
}

const NOW = Math.floor(Date.now() / 1000);

// [message id, user, surface, source, tier]
type Seed = Array<[string, string, string, string, number]>;

async function seed(sql: TestSql, rows: Seed): Promise<void> {
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES
    ('u-claude', 'ana@example.org', 'Ana', 'otel', 1, ?),
    ('u-openai', 'ben@example.org', 'Ben', 'openai', 1, ?),
    ('u-both', 'cy@example.org', 'Cy', 'otel', 1, ?)`, [NOW, NOW, NOW]);
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id) VALUES
    ('a-claude', 'ana@example.org', '__otel_pending__', 'pulse', 'Finance', 'u-claude'),
    ('a-openai', 'ben@example.org', '__otel_pending__', 'pulse', 'Finance', 'u-openai'),
    ('a-both', 'cy@example.org', '__otel_pending__', 'pulse', 'Finance', 'u-both')`);
  for (const [id, user, surface, source, tier] of rows) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
      VALUES (?, ?, ?, 'cowork_user_message', ?, ?, ?)`, [id, `s-${id}`, user, surface, source, NOW - 60]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
      VALUES (?, ?, ?, 'analysis', 0.9, 'test', ?)`, [id, user, tier, NOW - 60]);
  }
}

const MIXED: Seed = [
  ['m1', 'u-claude', 'cowork', 'otel', 3],
  ['m2', 'u-claude', 'cowork', 'otel', 3],
  ['m3', 'u-openai', 'cowork', 'chatgpt_chat', 1],
  ['m4', 'u-openai', 'cowork', 'chatgpt_work', 1],
  ['m5', 'u-both', 'chat', 'compliance', 2],      // Claude Chat
  ['m6', 'u-both', 'cowork', 'chatgpt_chat', 1],
];

describe('Work Pulse figures by vendor', () => {
  it('saves Claude and OpenAI figures apart, and all products unchanged', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql, MIXED);
      const { runHourlyAggregation } = await import('@/lib/pulse/aggregator');
      await runHourlyAggregation();

      // All products: Cy's two prompts, Tier 2 and Tier 1.
      const all = await sql.all<{ dds: number; tier_1_count: number; tier_2_count: number }>(
        `SELECT dds, tier_1_count, tier_2_count FROM pulse_metrics WHERE scope_type = 'user' AND scope_id = 'u-both' AND granularity = 'rolling'`);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ dds: 1.5, tier_1_count: 1, tier_2_count: 1 });

      // Per vendor, per person.
      const users = await sql.all<{ vendor: string; scope_id: string; dds: number; event_count: number }>(
        `SELECT vendor, scope_id, dds, event_count FROM pulse_metrics_vendor
          WHERE scope_type = 'user' AND granularity = 'rolling' ORDER BY vendor, scope_id`);
      expect(users).toEqual([
        { vendor: 'claude', scope_id: 'u-both', dds: 2, event_count: 1 },
        { vendor: 'claude', scope_id: 'u-claude', dds: 3, event_count: 2 },
        { vendor: 'openai', scope_id: 'u-both', dds: 1, event_count: 1 },
        { vendor: 'openai', scope_id: 'u-openai', dds: 1, event_count: 2 },
      ]);

      // Per vendor, per department.
      const dept = await sql.all<{ vendor: string; tier_1_count: number; tier_2_count: number; tier_3_count: number }>(
        `SELECT vendor, tier_1_count, tier_2_count, tier_3_count FROM pulse_metrics_vendor
          WHERE scope_type = 'function' AND scope_id = 'Finance' AND granularity = 'rolling' ORDER BY vendor`);
      expect(dept).toEqual([
        { vendor: 'claude', tier_1_count: 0, tier_2_count: 1, tier_3_count: 2 },
        { vendor: 'openai', tier_1_count: 3, tier_2_count: 0, tier_3_count: 0 },
      ]);

      // Weekly rows, upserted: a second run leaves one row per vendor, scope and week.
      await runHourlyAggregation();
      const weekly = await sql.all<{ vendor: string; n: number }>(
        `SELECT vendor, COUNT(*) AS n FROM pulse_metrics_vendor
          WHERE granularity = 'week' AND scope_type = 'function' GROUP BY vendor ORDER BY vendor`);
      expect(weekly).toEqual([{ vendor: 'claude', n: 1 }, { vendor: 'openai', n: 1 }]);

      // The Executive View follows the switch, and the All view carries each part.
      const openai = await cio('openai');
      expect(openai.adoptionHero.weeklyActive).toBe(2);
      expect(openai.adoptionHero.meaningfulWorkPct).toBe(0);
      expect(openai.adoptionHero.avgDds).toBe(1);
      expect(openai.coworkCostUsd).toBeUndefined();
      const claude = await cio('claude');
      expect(claude.adoptionHero.weeklyActive).toBe(2);
      expect(claude.adoptionHero.meaningfulWorkPct).toBe(100);
      expect(claude.adoptionHero.avgDds).toBe(2.5);
      const allView = await cio('all');
      expect(allView.openaiPresent).toBe(true);
      expect(allView.adoptionHero.weeklyActive).toBe(3);
      expect(allView.heroSplit.claude.weeklyActive).toBe(2);
      expect(allView.heroSplit.openai.weeklyActive).toBe(2);
      // No ChatGPT cost record yet: the spend figure says so rather than $0.
      expect(allView.chatgptCostUsd).toBeNull();

      // ChatGPT spend from OpenAI's cost records, beside Claude Cowork's, never in it.
      const hourAgo = Math.floor(Date.now() / 1000) - 3600;
      await sql.run(
        `INSERT INTO openai_costs (id, user_id, hour_start, product, model, cost_usd, billed_in) VALUES
           ('c1', 'u-both', ?, 'chatgpt', 'gpt-5.5', 4.25, 'CREDITS'),
           ('c2', 'u-both', ?, 'codex', 'gpt-5.5-codex', 9, 'CREDITS')`,
        [hourAgo, hourAgo],
      );
      const withCost = await cio('all');
      expect(withCost.chatgptCostUsd).toBe(4.25);
      expect(withCost.coworkCostUsd).toBe(allView.coworkCostUsd);
      expect((await cio('openai')).chatgptCostUsd).toBe(4.25);
      expect((await cio('claude')).chatgptCostUsd).toBeUndefined();

      // A person's erasure removes their per-vendor rows and OpenAI spend too.
      const { deleteUserData } = await import('@/lib/db/queries');
      await deleteUserData('u-both');
      const left = await sql.all<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM pulse_metrics_vendor WHERE scope_id = 'u-both')
              + (SELECT COUNT(*) FROM openai_costs WHERE user_id = 'u-both') AS n`);
      expect(left[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('gives briefings per-product facts, and none on a Claude-only window', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql, MIXED);
      const { buildProductFacts, productFactsBlock } = await import('@/lib/pulse/briefings/product-facts');
      const lines = await buildProductFacts({ periodStart: NOW - 3600, periodEnd: NOW + 1 });
      expect(lines).toEqual([
        'Claude Chat: 1 classified prompts, 1 person',
        'ChatGPT Chat: 2 classified prompts, 2 people',
        'Claude Cowork: 2 classified prompts, 1 person',
        'ChatGPT Work: 1 classified prompts, 1 person',
        'Share of work at Tier 2 or 3: Claude 100%, ChatGPT 0%',
      ]);
      // One person who used Claude only: no facts, so the briefing is unchanged.
      expect(await buildProductFacts({ periodStart: NOW - 3600, periodEnd: NOW + 1, userIds: ['u-claude'] })).toEqual([]);
      const { buildCioBriefingUserMessage } = await import('@/lib/pulse/briefings/prompts/cio');
      const msg = buildCioBriefingUserMessage({
        period_label: 'October 2026', weekly_active_users: 3, total_classified_events: 6,
        tier_1_pct: 50, tier_2_pct: 17, tier_3_pct: 33, avg_dds: 1.5, avg_oti: null,
        confirmed_capability_creation_count: 0, concentration_risk_count: 0, deep_work: [],
        teams_with_ors_below_threshold: [], departments_with_ors_count: 0, dept_process_opportunities: [],
        products: lines,
      });
      expect(msg).toContain(productFactsBlock(lines).trim());
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('leaves ChatGPT prompts out of the classifier queue when its switch is off', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql, MIXED);
      // Unjudged prompts: one Claude Cowork, two ChatGPT.
      for (const [id, user, source] of [['q1', 'u-claude', 'otel'], ['q2', 'u-openai', 'chatgpt_chat'], ['q3', 'u-openai', 'chatgpt_work']]) {
        await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
          VALUES (?, ?, ?, 'cowork_user_message', 'cowork', ?, 'Draft the summary', ?)`, [id, `s-${id}`, user, source, NOW - 60]);
      }
      const { NextRequest } = await import('next/server');
      const { GET } = await import('../app/api/pulse/admin/health/route');
      const health = async () => (await GET(new NextRequest('http://localhost/api/pulse/admin/health'))).json();

      expect((await health()).queueDepth).toBe(3);
      const { setConfigValue } = await import('@/lib/config');
      await setConfigValue('pulseClassifyChatgpt', 'false');
      const off = await health();
      expect(off.queueDepth).toBe(1);
      expect(off.classifyChatgpt).toBe(false);
      // The per-product table still shows the ChatGPT prompts being left alone.
      const waiting = Object.fromEntries(off.byProduct.map((r: { product: string; waiting: number }) => [r.product, r.waiting]));
      expect(waiting).toMatchObject({ claude_cowork: 1, chatgpt_chat: 1, chatgpt_work: 1 });
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('saves nothing per vendor on a Claude-only hub', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql, [['m1', 'u-claude', 'cowork', 'otel', 3]]);
      const { runHourlyAggregation } = await import('@/lib/pulse/aggregator');
      await runHourlyAggregation();
      const n = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pulse_metrics_vendor`);
      expect(n[0].n).toBe(0);
      const all = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pulse_metrics WHERE scope_id = 'u-claude'`);
      expect(all[0].n).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

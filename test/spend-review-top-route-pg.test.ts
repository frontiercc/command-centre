// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review index: each person's top route, the one the overview lists.
// It is their largest-saving route, taken from the same routes the route
// count counts, so the list and "Better routes waiting" never disagree.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const NOW = SEPT + 20 * DAY;

describe('spend review index top route (postgres)', () => {
  it('leads with the largest saving, and only for people with a route', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle inserts across many tables in a test
      const db = client as any;

      await db.insert(schema.users).values([
        { id: 'u-toby', email: 'toby@test.local', display_name: 'Toby Example', department: 'Sales' },
        { id: 'u-p1', email: 'p1@test.local', display_name: 'Peer One', department: 'Sales' },
        { id: 'u-p2', email: 'p2@test.local', display_name: 'Peer Two', department: 'Ops' },
        { id: 'u-p3', email: 'p3@test.local', display_name: 'Peer Three', department: 'Ops' },
      ]);

      let n = 0;
      const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
      async function coworkSession(userId: string, opts: { at: number; cost: number; model: string; taskType: string | null; tier?: number; skills?: string[]; produced?: 0 | 1 | null; prompt?: string }) {
        const sid = `cw-${++n}`;
        await db.insert(schema.coworkSessions).values({ id: sid, conversation_id: `conv-${n}`, user_id: userId, started_at: opts.at });
        const promptId = `${sid}-prompt`;
        await db.insert(schema.coworkMessages).values([
          { id: promptId, session_id: sid, user_id: userId, message_type: 'cowork_user_message', content_full: opts.prompt ?? `prompt for ${sid}`, occurred_at: opts.at, surface: 'cowork' },
          { id: `${sid}-api`, session_id: sid, user_id: userId, message_type: 'cowork_api_request', model: opts.model, cost_usd: String(opts.cost), token_usage: usage, occurred_at: opts.at + 60, surface: 'cowork' },
        ]);
        if (opts.taskType) {
          await db.insert(schema.pulseClassifications).values({
            cowork_message_id: promptId, user_id: userId, tier: opts.tier ?? 2, task_type: opts.taskType,
            classifier_confidence: 0.9, classifier_model: 'test', classified_at: opts.at,
          });
        }
        await db.insert(schema.coworkSessionStats).values({
          session_id: sid, user_id: userId, first_event_at: opts.at, last_event_at: opts.at + 600,
          active_secs: 600, tool_call_count: 4, produced_output: opts.produced ?? null, computed_at: opts.at,
        });
        for (const s of opts.skills ?? []) await db.insert(schema.coworkSkillInvocations).values({ id: `${sid}-s-${s}`, user_id: userId, session_id: sid, skill_name: s, occurred_at: opts.at + 30 });
      }

      // Toby: structured reports on Opus. Colleagues do the same work on Sonnet with a skill
      // Toby has never used, so Toby has two routes: the skill (no saving figure) and a cheaper
      // model trial (with one).
      for (let i = 0; i < 3; i++) {
        await coworkSession('u-toby', { at: SEPT + (2 + i) * DAY, cost: 10, model: 'claude-opus-4-6', taskType: 'structured_report', tier: 3, produced: 1 });
      }
      for (const p of ['u-p1', 'u-p2', 'u-p3']) {
        for (let i = 0; i < 2; i++) {
          await coworkSession(p, { at: SEPT - (10 + i) * DAY, cost: 2, model: 'claude-sonnet-4-6', taskType: 'structured_report', skills: ['deck-builder'] });
        }
      }
      // Peer Two: a scheduled task on Opus this month, the only route they have.
      for (const i of [0, 1]) {
        await coworkSession('u-p2', { at: SEPT + (10 + i) * DAY, cost: 3, model: 'claude-opus-4-6', taskType: null, prompt: '<scheduled-task name="nightly-digest" file="/x/SKILL.md"> This is an automated run.' });
      }
      // Peer Three: unclassified work this month on Sonnet, so no route at all.
      await coworkSession('u-p3', { at: SEPT + 12 * DAY, cost: 1, model: 'claude-sonnet-4-6', taskType: null });

      const { buildSpendReview, buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const index = await buildSpendReviewIndex(PERIOD, NOW);
      const row = (id: string) => index.people.find(p => p.userId === id)!;

      // Toby: two routes; the top one is the largest saving the person's page shows.
      const toby = row('u-toby');
      expect(toby.routeCount).toBe(2);
      const review = await buildSpendReview('u-toby', PERIOD, NOW);
      const routes = review.work.flatMap(w => w.routes);
      expect(routes.some(r => r.kind === 'tool')).toBe(true);
      const savings = routes.map(r => (r.kind === 'model' ? r.estSavingUsd : null)).filter((v): v is number => v !== null);
      expect(savings.length).toBeGreaterThan(0);
      expect(toby.topRoute).toMatchObject({ kind: 'model', direction: 'trial', fromModel: 'claude-opus-4-6', toModel: 'claude-haiku-5-5', workLabel: 'Structured report', surface: 'cowork' });
      expect(toby.topRoute!.estSavingUsd).toBeCloseTo(Math.max(...savings), 6);
      expect(toby.topRoute!.workShare).toBeCloseTo(1, 6);

      // Peer Two: a scheduled task is a route with no saving figure.
      const p2 = row('u-p2');
      expect(p2.routeCount).toBe(1);
      expect(p2.topRoute).toMatchObject({ kind: 'scheduled', name: 'nightly-digest', fromModel: 'claude-opus-4-6', cheaperFamilies: ['Sonnet', 'Haiku'], surface: 'cowork', estSavingUsd: null });
      expect(p2.topRoute!.workShare).toBeCloseTo(1, 6);

      // Peer Three: no route, no top route.
      const p3 = row('u-p3');
      expect(p3.routeCount).toBe(0);
      expect(p3.topRoute).toBeNull();

      // The list and the count agree, person by person.
      for (const p of index.people) expect(p.topRoute !== null).toBe(p.routeCount > 0);
      expect(index.people.filter(p => p.topRoute !== null).length).toBe(index.summary.peopleWithRoutes);
      expect(index.summary.peopleWithRoutes).toBe(2);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('picks the largest saving, then the bigger share of spend', async () => {
    const { pickTopRoute } = await import('@/lib/finance/spend-review');
    const base = { surface: 'cowork' as const };
    const tool = { kind: 'tool' as const, toolType: 'connector' as const, name: 'slack', workLabel: 'A', workShare: 0.9, estSavingUsd: null, ...base };
    const small = { kind: 'model' as const, direction: 'save' as const, fromModel: 'x', toModel: 'y', workLabel: 'B', workShare: 0.2, estSavingUsd: 3, ...base };
    const big = { ...small, workLabel: 'C', estSavingUsd: 8 };
    const context = { kind: 'context' as const, workLabel: 'D', workShare: 0.5, estSavingUsd: null, ...base };
    expect(pickTopRoute([])).toBeNull();
    expect(pickTopRoute([tool, small, big])).toBe(big);
    expect(pickTopRoute([context, tool])).toBe(tool);
    expect(pickTopRoute([tool, { ...tool, workLabel: 'E' }])).toBe(tool);
    // A proven save outranks an untested trial, however much bigger the trial's saving.
    const trial = { kind: 'model' as const, direction: 'trial' as const, fromModel: 'x', toModel: 'z', workLabel: 'F', workShare: 0.5, estSavingUsd: 50, ...base };
    expect(pickTopRoute([trial, small])).toBe(small);
    expect(pickTopRoute([trial, tool])).toBe(trial);
  });
});

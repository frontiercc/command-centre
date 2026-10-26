// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review engine on Postgres: one person's month by kind of work, the
// colleague comparison, the skill and cheaper-model routes, the unpriced-model
// rule, the access rule, and agreement with FinOps chargeback.
//
// Integer and numeric columns come back as STRINGS through this driver; every
// figure below would be wrong (string concatenation, or NaN) if the engine
// skipped a Number() coercion.
//
// HARNESS RULE: modules reaching getClient() are dynamic-imported after
// createTestDbClient() has bound DATABASE_URL.
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const PERIOD = '2026-09';
const SEPT = Date.UTC(2026, 8, 1) / 1000;
const NOW = SEPT + 20 * DAY;

describe('spend review (postgres)', () => {
  it('breaks a month down by kind of work and finds better routes from colleagues', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      const { priceTokens, DEFAULT_RATES } = await import('@/lib/pulse/code/rates');
      const db = client as any;

      const people = [
        { id: 'u-toby', email: 'toby@test.local', display_name: 'Toby Example', department: 'Sales' },
        { id: 'u-p1', email: 'p1@test.local', display_name: 'Peer One', department: 'Sales' },
        { id: 'u-p2', email: 'p2@test.local', display_name: 'Peer Two', department: 'Ops' },
        { id: 'u-p3', email: 'p3@test.local', display_name: 'Peer Three', department: 'Ops' },
      ];
      await db.insert(schema.users).values(people);

      let n = 0;
      const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
      async function coworkSession(userId: string, opts: { at: number; cost: number; model: string; taskType: string | null; tier?: number; skills?: string[]; connectors?: string[]; produced?: 0 | 1 | null; output?: string; prompt?: string }) {
        const sid = `cw-${++n}`;
        await db.insert(schema.coworkSessions).values({ id: sid, conversation_id: `conv-${n}`, user_id: userId, started_at: opts.at });
        const promptId = `${sid}-prompt`;
        await db.insert(schema.coworkMessages).values([
          { id: promptId, session_id: sid, user_id: userId, message_type: 'cowork_user_message', content_full: opts.prompt ?? `prompt for ${sid}`, occurred_at: opts.at, surface: 'cowork' },
          { id: `${sid}-api`, session_id: sid, user_id: userId, message_type: 'cowork_api_request', model: opts.model, cost_usd: String(opts.cost), token_usage: usage, occurred_at: opts.at + 60, surface: 'cowork' },
          ...(opts.output ? [{ id: `${sid}-out`, session_id: sid, user_id: userId, message_type: 'cowork_tool_metadata', output_name: opts.output, occurred_at: opts.at + 90, surface: 'cowork' }] : []),
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
        for (const c of opts.connectors ?? []) await db.insert(schema.coworkMcpInvocations).values({ id: `${sid}-c-${c}`, user_id: userId, session_id: sid, mcp_server: c, mcp_tool: 'call', occurred_at: opts.at + 30 });
        return sid;
      }

      // Toby: three structured reports on Opus at $10, one unclassified at $2.
      for (let i = 0; i < 3; i++) {
        await coworkSession('u-toby', { at: SEPT + (2 + i) * DAY, cost: 10, model: 'claude-opus-4-6', taskType: 'structured_report', tier: 3, produced: 1, output: `deck-${i}.pptx`, skills: i === 0 ? ['pdf'] : [] });
      }
      await coworkSession('u-toby', { at: SEPT + 6 * DAY, cost: 2, model: 'claude-opus-4-6', taskType: null, produced: 0 });

      // Three colleagues: two structured reports each, on Sonnet, with the deck-builder skill.
      // Only two of them use the gamma connector, which is below the three-person floor.
      for (const [idx, p] of ['u-p1', 'u-p2', 'u-p3'].entries()) {
        for (let i = 0; i < 2; i++) {
          await coworkSession(p, { at: SEPT - (10 + i) * DAY, cost: 2, model: 'claude-sonnet-4-6', taskType: 'structured_report', skills: ['deck-builder'], connectors: idx < 2 ? ['gamma'] : [] });
        }
      }
      await db.insert(schema.skillLibraryEntries).values({ name: 'deck-builder', type: 'skill', is_published: 1 });

      // Toby's Code: one priced session plus usage on a model with no rate.
      await db.insert(schema.codeSessionStats).values({ session_id: 'code-1', user_id: 'u-toby', first_at: SEPT + 8 * DAY, last_at: SEPT + 8 * DAY + 900, user_msg_count: 5, tool_use_count: 20, commit_count: 2, active_secs: 900, computed_at: NOW });
      await db.insert(schema.codeSessionClassifications).values({ session_id: 'code-1', user_id: 'u-toby', work_type: 'feature', tier: 2, confidence: 0.8, classifier_model: 'test', classified_at: NOW });
      await db.insert(schema.codeAssistantMeta).values([
        { id: 'cam-1', user_id: 'u-toby', session_id: 'code-1', model: 'claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0, occurred_at: SEPT + 8 * DAY },
        { id: 'cam-2', user_id: 'u-toby', session_id: 'code-1', model: 'mystery-model', input_tokens: 500, output_tokens: 500, occurred_at: SEPT + 8 * DAY + 10 },
      ]);

      const { buildSpendReview, buildSpendReviewIndex } = await import('@/lib/finance/spend-review');
      const review = await buildSpendReview('u-toby', PERIOD, NOW);

      expect(review.displayName).toBe('Toby Example');
      expect(review.totals.coworkUsd).toBeCloseTo(32, 6);
      expect(review.totals.codeUsd).toBeCloseTo(3, 6);
      expect(review.totals.totalUsd).toBeCloseTo(35, 6);
      expect(review.totals.sessions).toBe(5);
      expect(review.unpricedModels).toEqual(['mystery-model']);

      const report = review.work[0];
      expect(report.key).toBe('cowork:structured_report');
      expect(report.spendUsd).toBeCloseTo(30, 6);
      expect(report.share).toBeCloseTo(30 / 35, 6);
      expect(report.sessions).toBe(3);
      expect(report.typicalSessionUsd).toBeCloseTo(10, 6);
      expect(report.peer).toEqual({ users: 3, sessions: 6, typicalSessionUsd: 2 });
      expect(report.produced).toEqual({ measured: 3, produced: 3 });
      expect(report.deepSessions).toBe(3);
      expect(report.topModel).toEqual({ model: 'claude-opus-4-6', share: 1 });

      const tool = report.routes.find(r => r.kind === 'tool');
      expect(tool).toMatchObject({ kind: 'tool', toolType: 'skill', name: 'deck-builder', peerUsers: 3, peerSessionShare: 1 });
      expect((tool as { libraryEntryId: number | null }).libraryEntryId).toEqual(expect.any(Number));
      expect(report.routes.some(r => r.kind === 'tool' && r.name === 'gamma')).toBe(false);

      const model = report.routes.find(r => r.kind === 'model');
      const threeCalls = { inputTokens: 3_000_000, outputTokens: 300_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
      // Colleagues' Sonnet has only 6 sessions behind it, under the 20 a suggestion needs, so
      // no evidenced save: the advice is a labelled trial of the cheapest model instead.
      const expectedSaving = priceTokens('claude-opus-4-6', threeCalls, DEFAULT_RATES)! - priceTokens('claude-haiku-4-5', threeCalls, DEFAULT_RATES)!;
      expect(model).toMatchObject({ kind: 'model', direction: 'trial', fromModel: 'claude-opus-4-6', toModel: 'claude-haiku-4-5', metric: null });
      expect((model as { estSavingUsd: number }).estSavingUsd).toBeCloseTo(expectedSaving, 6);
      const fitRow = report.models.find(r => r.model === 'claude-sonnet-4-6')!;
      expect(fitRow.colleagues).toMatchObject({ people: 3, sessions: 6, typicalSessionUsd: 2, deepRate: 0 });
      expect(report.models.find(r => r.model === 'claude-opus-4-6')).toMatchObject({ you: { sessions: 3, typicalSessionUsd: 10 }, colleagues: null });

      // Code: no colleagues did feature work, so no comparison and no route.
      const code = review.work.find(w => w.key === 'code:feature')!;
      expect(code.spendUsd).toBeCloseTo(3, 6);
      expect(code.commits).toBe(2);
      expect(code.peer).toBeNull();
      expect(code.routes).toEqual([]);
      // ...but its own models still show, with spend per model, the unpriced one included.
      expect(code.models.map(m => m.model).sort()).toEqual(['claude-sonnet-4-6', 'mystery-model']);
      expect(code.models[0]).toMatchObject({ model: 'claude-sonnet-4-6', spendShare: 1, colleagues: null });
      expect(code.models[0].spendUsd).toBeCloseTo(3, 6);
      expect(code.models.find(m => m.model === 'mystery-model')!.spendUsd).toBeNull();

      // Cost drivers: the FinOps functions over the person's month, priced models only.
      const me = review.modelEfficiency;
      expect(me.spendByModel.map(m => m.model)).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
      expect(me.spendByModel[0].spendUsd).toBeCloseTo(32, 6);
      expect(me.spendByModel[1].spendUsd).toBeCloseTo(3, 6);
      const ct = me.costByType;
      expect(ct.inputUsd + ct.outputUsd + ct.cacheWriteUsd + ct.cacheReadUsd + ct.unclassifiedUsd).toBeCloseTo(35, 6);
      expect(me.cacheEfficiency.ratio).toBe(0); // no cache reads seeded

      // Unclassified spend is shown, last, with no routes.
      const last = review.work[review.work.length - 1];
      expect(last.workKey).toBeNull();
      expect(last.label).toBe('Not classified yet');
      expect(last.spendUsd).toBeCloseTo(2, 6);

      // Sessions: most expensive first; the Code session flags its unpriced part.
      expect(review.sessions[0].spendUsd).toBeCloseTo(10, 6);
      const codeSession = review.sessions.find(s => s.surface === 'code')!;
      expect(codeSession).toMatchObject({ hasUnpriced: true, commits: 2, activeSecs: 900, prompts: 5, actions: 20 });
      expect(review.sessions.find(s => s.outputs.includes('deck-0.pptx'))?.producedOutput).toBe(true);

      // The index uses FinOps's own figures for the same month.
      const { buildChargeback } = await import('@/lib/finance/chargeback');
      const cb = await buildChargeback(PERIOD, NOW);
      const cbToby = [...cb.costCentres.flatMap(c => c.users), ...cb.unallocated.users].find(u => u.userId === 'u-toby')!;
      const index = await buildSpendReviewIndex(PERIOD, NOW);
      const row = index.people.find(p => p.userId === 'u-toby')!;
      expect(row.totalUsd).toBeCloseTo(cbToby.totalUsd, 6);
      expect(row.totalUsd).toBeCloseTo(review.totals.totalUsd, 6);
      expect(row.email).toBe('toby@test.local');
      // The index counts the same routes the review shows, and names the main kind of work.
      const { suggestionKey } = await import('@/lib/finance/spend-review');
      expect(row.routeCount).toBe(new Set(review.work.flatMap(w => w.routes.map(suggestionKey))).size);
      expect(row.routeCount).toBe(2);
      expect(row.mainWork).toMatchObject({ label: 'Structured Report', surface: 'cowork' });
      expect(row.mainWork!.share).toBeCloseTo(30 / 35, 6);
      expect(row.unpricedOnly).toBe(false);
      expect(index.summary.peopleWithRoutes).toBe(1);
      // Toby has 5 sessions this month: under the 10 the efficiency board needs.
      expect(index.efficiency).toEqual([]);
      expect(index.summary.topWork[0]).toMatchObject({ label: 'Structured Report', surface: 'cowork' });

      // A blank admin-side name or department never hides the users row's (seen on a production deployment).
      await db.insert(schema.adminUsers).values({ id: 'adm-toby', email: 'toby@test.local', password_hash: 'x', role: 'pulse', display_name: '', department: '', linked_cowork_user_id: 'u-toby' });
      const again = (await buildSpendReviewIndex(PERIOD, NOW)).people.find(p => p.userId === 'u-toby')!;
      expect(again).toMatchObject({ department: 'Sales', displayName: 'Toby Example' });
      expect((await buildSpendReview('u-toby', PERIOD, NOW)).department).toBe('Sales');

      // A scheduled task running unattended on an Opus-class model is suggested on the page and counted in the index.
      for (const i of [0, 1]) {
        await coworkSession('u-p2', { at: SEPT + (10 + i) * DAY, cost: 3, model: 'claude-opus-4-6', taskType: null, prompt: '<scheduled-task name="nightly-digest" file="/x/SKILL.md"> This is an automated run.' });
      }
      const p2 = await buildSpendReview('u-p2', PERIOD, NOW);
      expect(p2.scheduledTasks).toHaveLength(1);
      expect(p2.scheduledTasks[0]).toMatchObject({ name: 'nightly-digest', surface: 'cowork', runs: 2, days: 2, mainModel: 'claude-opus-4-6', cheaperFamilies: ['Sonnet', 'Haiku'] });
      expect(p2.scheduledTasks[0].spendUsd).toBeCloseTo(6, 6);
      expect(p2.sessions.filter(x => x.scheduledTask === 'nightly-digest')).toHaveLength(2);
      const p2Row = (await buildSpendReviewIndex(PERIOD, NOW)).people.find(p => p.userId === 'u-p2')!;
      const p2Keys = new Set([...p2.work.flatMap(w => w.routes.map(suggestionKey)), ...p2.scheduledTasks.filter(t => t.cheaperFamilies.length).map(t => `scheduled:${t.surface}:${t.name}`)]);
      expect(p2Row.routeCount).toBe(p2Keys.size);
      expect(p2Row.routeCount).toBeGreaterThanOrEqual(1);

      // Access: managers see anyone; a person sees their own and nobody else's.
      const { canViewSpendReview } = await import('@/lib/finance/spend-review-access');
      expect(await canViewSpendReview({ authenticated: true, role: 'manager', userId: 'adm-1', email: 'boss@test.local' }, 'u-toby')).toBe(true);
      expect(await canViewSpendReview({ authenticated: true, role: 'pulse', userId: 'adm-2', email: 'toby@test.local' }, 'u-toby')).toBe(true);
      expect(await canViewSpendReview({ authenticated: true, role: 'pulse', userId: 'adm-2', email: 'toby@test.local' }, 'u-p1')).toBe(false);
      expect(await canViewSpendReview({ authenticated: true, role: 'viewer', userId: 'adm-3', email: 'nobody@test.local' }, 'u-toby')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 180_000);
});

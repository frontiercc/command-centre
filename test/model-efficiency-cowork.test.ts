// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildModelEfficiency: typeof import('@/lib/finance/model-efficiency').buildModelEfficiency;
let parseCoworkTokenUsage: typeof import('@/lib/finance/model-efficiency').parseCoworkTokenUsage;
let MIN_SPEND: number;

const NOW = Math.floor(Date.parse('2026-07-20T00:00:00Z') / 1000);
const OCCURRED_AT = Math.floor(Date.UTC(2026, 6, 10) / 1000); // inside July 2026

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/finance/model-efficiency');
  buildModelEfficiency = mod.buildModelEfficiency;
  parseCoworkTokenUsage = mod.parseCoworkTokenUsage;
  MIN_SPEND = mod.MIN_SPEND;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications;
           DELETE FROM cowork_mcp_invocations;
           DELETE FROM cowork_skill_invocations;
           DELETE FROM cowork_messages;`);
});

function tokenUsageJson(opts: { inputTokens: number; outputTokens: number }): string {
  return JSON.stringify({
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

/** Insert a cowork_messages row with message_type='cowork_api_request' (spend). */
async function seedApiRequest(opts: {
  id: string;
  sessionId: string;
  model: string | null;
  costUsd: number | null;
  tokenUsage: string | null; // pre-serialised JSON, or null to omit
}) {
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, model, cost_usd, token_usage, occurred_at, ingested_at)
     VALUES (?, ?, 'user-1', 'cowork_api_request', ?, ?, ?, ?, ?)`,
    [opts.id, opts.sessionId, opts.model, opts.costUsd, opts.tokenUsage, OCCURRED_AT, NOW],
  );
}

let classSeq = 0;
/**
 * Insert a cowork_user_message row (the row the classifier actually
 * classifies, per lib/pulse/classifier.ts) PLUS its pulse_classifications
 * row, matching the real production model: spend lives
 * on a DIFFERENT cowork_messages row (cowork_api_request) in the SAME
 * session, so task_type attribution is joined via session_id, not via a
 * shared message id.
 */
async function seedClassifiedUserMessage(id: string, sessionId: string, taskType: string, occurredAt: number = OCCURRED_AT) {
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, ingested_at)
     VALUES (?, ?, 'user-1', 'cowork_user_message', ?, ?)`,
    [id, sessionId, occurredAt, NOW],
  );
  await sql.run(
    `INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classified_at)
     VALUES (?, ?, 'user-1', 1, ?, 0.9, 'test-model', 'classified', ?)`,
    [++classSeq, id, taskType, occurredAt],
  );
}

async function seedSkillInvocation(id: string, sessionId: string, skillName: string) {
  await sql.run(
    `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
     VALUES (?, 'user-1', ?, ?, ?)`,
    [id, sessionId, skillName, OCCURRED_AT],
  );
}

async function seedMcpInvocation(id: string, sessionId: string, mcpServer: string) {
  await sql.run(
    `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
     VALUES (?, 'user-1', ?, ?, 'some_tool', ?)`,
    [id, sessionId, mcpServer, OCCURRED_AT],
  );
}

describe('parseCoworkTokenUsage', () => {
  it('returns null for null/undefined/malformed input', () => {
    expect(parseCoworkTokenUsage(null)).toBeNull();
    expect(parseCoworkTokenUsage('not json')).toBeNull();
    expect(parseCoworkTokenUsage('42')).toBeNull(); // valid JSON, not an object
  });

  it('returns null (never zeros) for a JSON array', () => {
    // typeof [] === 'object' in JS -- without an explicit Array.isArray guard
    // this would fall through to Number(undefined)||0 on every field and
    // silently produce an all-zero TokenUsage instead of "no token data".
    expect(parseCoworkTokenUsage('[]')).toBeNull();
    expect(parseCoworkTokenUsage('[1,2,3]')).toBeNull();
  });

  it('maps the receiver-persisted camelCase shape 1:1', () => {
    const usage = parseCoworkTokenUsage(
      JSON.stringify({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 10, cacheCreationTokens: 20 })
    );
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 200, cacheCreationTokens: 20, cacheReadTokens: 10 });
  });
});

describe('buildModelEfficiency (cowork)', () => {
  it('groups by session-derived task_type, flags a single-premium-model activity (share-based, no target), and tolerates a null token_usage row', async () => {
    // 6 sessions, all on the premium model 'claude-opus-4-8' — no cheaper
    // model in use for this activity, so even once flagged the ceiling must
    // be null (no-target case). Real measured spend = 6 * $6 = $36 (>= MIN_SPEND).
    // 5 rows carry parseable token_usage (aggregate 750k in / 750k out ->
    // ~$22.50 estimated premium spend -> ~63% share, comfortably over the
    // 40% threshold); the 6th row's token_usage is null and must NOT prevent
    // the activity from appearing or from being flagged.
    // Each session's task_type comes from a SEPARATE cowork_user_message +
    // pulse_classifications row (same session_id, different message id) —
    // the real production join, not a shared id with the spend row.
    for (let i = 0; i < 6; i++) {
      const sessionId = `opus-sess-${i}`;
      await seedApiRequest({
        id: `msg-opus-${i}`,
        sessionId,
        model: 'claude-opus-4-8',
        costUsd: 6,
        tokenUsage: i < 5 ? tokenUsageJson({ inputTokens: 150_000, outputTokens: 150_000 }) : null,
      });
      await seedClassifiedUserMessage(`msg-um-opus-${i}`, sessionId, 'budget_analysis');
    }
    await seedSkillInvocation('sk-1', 'opus-sess-0', 'financial-modeling');
    await seedSkillInvocation('sk-2', 'opus-sess-1', 'financial-modeling');
    await seedMcpInvocation('mcp-1', 'opus-sess-2', 'Salesforce');

    // A second, low-volume task_type — below MIN_SESSIONS, never flagged.
    for (let i = 0; i < 2; i++) {
      const sessionId = `quick-sess-${i}`;
      await seedApiRequest({
        id: `msg-quick-${i}`,
        sessionId,
        model: 'claude-haiku-4-5',
        costUsd: 1,
        tokenUsage: tokenUsageJson({ inputTokens: 10_000, outputTokens: 10_000 }),
      });
      await seedClassifiedUserMessage(`msg-um-quick-${i}`, sessionId, 'quick_reply');
    }

    // An unclassified row: a session with a spend row but NO cowork_user_message
    // / pulse_classifications at all.
    await seedApiRequest({
      id: 'msg-unclassified-0',
      sessionId: 'unclass-sess-0',
      model: 'claude-haiku-4-5',
      costUsd: 2,
      tokenUsage: tokenUsageJson({ inputTokens: 5_000, outputTokens: 5_000 }),
    });

    const r = await buildModelEfficiency('cowork', '2026-07', NOW);

    expect(r.surface).toBe('cowork');
    expect(r.hasData).toBe(true);
    expect(r.period.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000));
    expect(r.period.end).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000));

    // Every Cowork activity has friction === null, unconditionally.
    for (const activity of r.activities) {
      expect(activity.friction).toBeNull();
    }

    const budget = r.activities.find((a) => a.key === 'budget_analysis')!;
    expect(budget).toBeDefined();
    // All 6 rows' cost_usd counted, including the null-token_usage row.
    expect(budget.totalSpendUsd).toBe(36);
    expect(budget.totalSpendUsd).toBeGreaterThanOrEqual(MIN_SPEND);
    expect(budget.byModel).toHaveLength(1);
    expect(budget.byModel[0].model).toBe('claude-opus-4-8');

    expect(budget.flag).toBeDefined();
    expect(budget.flag?.premiumModel).toBe('claude-opus-4-8');
    expect(budget.flag?.premiumShare).toBeGreaterThanOrEqual(0.4);
    expect(budget.flag?.shareBasedOnly).toBe(true);
    expect(budget.flag?.suppressedReason).toBeUndefined();
    // No cheaper model in use for this activity -> no target -> no ceiling,
    // regardless of the one row with no parseable tokens.
    expect(budget.flag?.targetModel).toBeNull();
    expect(budget.flag?.estCeilingUsd).toBeNull();

    // Measured drill-down: skill + connector INVOCATION COUNTS (in `count`,
    // never `spendUsd`).
    const skillEntry = budget.measuredBreakdown.find((b) => b.dimension === 'skill' && b.key === 'financial-modeling');
    expect(skillEntry).toBeDefined();
    expect(skillEntry?.count).toBe(2);
    expect(skillEntry?.spendUsd).toBe(0);
    const connectorEntry = budget.measuredBreakdown.find((b) => b.dimension === 'connector' && b.key === 'Salesforce');
    expect(connectorEntry).toBeDefined();
    expect(connectorEntry?.count).toBe(1);
    expect(connectorEntry?.spendUsd).toBe(0);

    const quick = r.activities.find((a) => a.key === 'quick_reply');
    expect(quick).toBeDefined();
    expect(quick?.flag).toBeUndefined();
    expect(quick?.friction).toBeNull();
    expect(r.belowVolume.some((b) => b.key === 'quick_reply')).toBe(true);

    const unclassified = r.activities.find((a) => a.key === 'unclassified');
    expect(unclassified).toBeDefined();
    expect(unclassified?.totalSpendUsd).toBe(2);

    // Reconciliation invariant, pinned on the BUILT report (not just the pure
    // computeCostByType helper): the five costByType terms must sum to the
    // priced-only spendByModel total. NOTE: this is deliberately NOT asserted
    // against r.totals.spendUsd here -- on Cowork that total also includes the
    // unpriced 'mystery-model-9000' / null-model cost_usd (see the "unpriced
    // model" test below), which costByType correctly excludes.
    const costByTypeSum =
      r.costByType.inputUsd + r.costByType.outputUsd + r.costByType.cacheWriteUsd + r.costByType.cacheReadUsd + r.costByType.unclassifiedUsd;
    const pricedSpendSum = r.spendByModel.reduce((s, m) => s + m.spendUsd, 0);
    expect(costByTypeSum).toBeCloseTo(pricedSpendSum, 5);
  });

  it('collapses a session with multiple classifications to the most-frequent task_type, tie-breaking on the most recent occurrence', async () => {
    // Majority case: 3x 'research' (early timestamps) vs 2x 'writing' (LATER
    // timestamps) — count wins over recency, so the session's spend must
    // land under 'research', not 'writing'.
    await seedClassifiedUserMessage('msg-um-maj-1', 'collapse-majority-sess', 'research', OCCURRED_AT + 1);
    await seedClassifiedUserMessage('msg-um-maj-2', 'collapse-majority-sess', 'research', OCCURRED_AT + 2);
    await seedClassifiedUserMessage('msg-um-maj-3', 'collapse-majority-sess', 'research', OCCURRED_AT + 3);
    await seedClassifiedUserMessage('msg-um-maj-4', 'collapse-majority-sess', 'writing', OCCURRED_AT + 100);
    await seedClassifiedUserMessage('msg-um-maj-5', 'collapse-majority-sess', 'writing', OCCURRED_AT + 101);
    await seedApiRequest({
      id: 'msg-collapse-majority-spend',
      sessionId: 'collapse-majority-sess',
      model: 'claude-haiku-4-5',
      costUsd: 10,
      tokenUsage: tokenUsageJson({ inputTokens: 20_000, outputTokens: 20_000 }),
    });

    // Tie case: 1x 'alpha' (earlier) vs 1x 'beta' (later) — equal counts, so
    // the tie-break picks whichever task_type's latest occurrence is newest:
    // 'beta'.
    await seedClassifiedUserMessage('msg-um-tie-1', 'collapse-tie-sess', 'alpha', OCCURRED_AT + 1);
    await seedClassifiedUserMessage('msg-um-tie-2', 'collapse-tie-sess', 'beta', OCCURRED_AT + 50);
    await seedApiRequest({
      id: 'msg-collapse-tie-spend',
      sessionId: 'collapse-tie-sess',
      model: 'claude-haiku-4-5',
      costUsd: 7,
      tokenUsage: tokenUsageJson({ inputTokens: 10_000, outputTokens: 10_000 }),
    });

    const r = await buildModelEfficiency('cowork', '2026-07', NOW);

    const research = r.activities.find((a) => a.key === 'research');
    const writing = r.activities.find((a) => a.key === 'writing');
    expect(research).toBeDefined();
    expect(research?.totalSpendUsd).toBe(10);
    expect(writing).toBeUndefined(); // no spend ever attributed to the minority task_type

    const beta = r.activities.find((a) => a.key === 'beta');
    const alpha = r.activities.find((a) => a.key === 'alpha');
    expect(beta).toBeDefined();
    expect(beta?.totalSpendUsd).toBe(7);
    expect(alpha).toBeUndefined(); // tie broken toward the more recent task_type
  });

  it('derives premiumShare from MEASURED per-model spend, not a list-repriced token estimate (never exceeds 1)', async () => {
    // Premium model (opus) rows: measured cost_usd is deliberately LOW ($5/row,
    // $30 total) while token_usage is large enough that list-repricing it
    // (priceTokens over the aggregated 1.8M in / 1.8M out tokens, at opus's
    // $5-in/$25-out rate) would come to $54 -- MORE than the $40 measured
    // total for the whole activity. The old (buggy) premiumShare
    // (listReprice / measuredTotal = 54/40 = 1.35) would render as "over 135%
    // of measured spend" and is provably wrong. The fixed premiumShare must
    // instead be the measured opus spend / measured total = 30/40 = 0.75 --
    // still comfortably over PREMIUM_SHARE_MIN (0.4) and still flagged, but
    // on the honest cost basis, and never > 1.
    for (let i = 0; i < 6; i++) {
      const sessionId = `reprice-opus-${i}`;
      await seedApiRequest({
        id: `msg-reprice-opus-${i}`,
        sessionId,
        model: 'claude-opus-4-8',
        costUsd: 5,
        tokenUsage: tokenUsageJson({ inputTokens: 300_000, outputTokens: 300_000 }),
      });
      await seedClassifiedUserMessage(`msg-um-reprice-opus-${i}`, sessionId, 'reprice_mismatch');
    }
    // One cheaper-model (sonnet) session with real measured spend, so the
    // premium model isn't the activity's only model (a meaningful ratio, not
    // a trivial 1.0-by-definition single-model case).
    await seedApiRequest({
      id: 'msg-reprice-sonnet-0',
      sessionId: 'reprice-sonnet-0',
      model: 'claude-sonnet-4-6',
      costUsd: 10,
      tokenUsage: tokenUsageJson({ inputTokens: 5_000, outputTokens: 5_000 }),
    });
    await seedClassifiedUserMessage('msg-um-reprice-sonnet-0', 'reprice-sonnet-0', 'reprice_mismatch');

    const r = await buildModelEfficiency('cowork', '2026-07', NOW);

    const activity = r.activities.find((a) => a.key === 'reprice_mismatch')!;
    expect(activity).toBeDefined();
    expect(activity.totalSpendUsd).toBe(40); // 6*5 + 10, all measured cost_usd
    expect(activity.byModel.find((m) => m.model === 'claude-opus-4-8')?.spendUsd).toBe(30);

    expect(activity.flag).toBeDefined();
    expect(activity.flag?.premiumModel).toBe('claude-opus-4-8');
    // Measured basis: 30 / 40 = 0.75 -- NOT the list-repriced 54 / 40 = 1.35.
    expect(activity.flag?.premiumShare).toBeCloseTo(0.75, 5);
    expect(activity.flag?.premiumShare).toBeLessThanOrEqual(1);
  });

  it('still counts real measured spend for an unpriced model, surfacing it in unpricedModels rather than dropping it', async () => {
    for (let i = 0; i < 6; i++) {
      const sessionId = `mystery-sess-${i}`;
      await seedApiRequest({
        id: `msg-mystery-${i}`,
        sessionId,
        model: 'mystery-model-9000',
        costUsd: 5,
        tokenUsage: tokenUsageJson({ inputTokens: 50_000, outputTokens: 50_000 }),
      });
      await seedClassifiedUserMessage(`msg-um-mystery-${i}`, sessionId, 'testing');
    }

    const r = await buildModelEfficiency('cowork', '2026-07', NOW);

    expect(r.unpricedModels).toContain('mystery-model-9000');
    const testing = r.activities.find((a) => a.key === 'testing')!;
    expect(testing).toBeDefined();
    // Real measured dollars still counted (Cowork spend = cost_usd, not a
    // priceTokens derivation) -- unlike Code, where an unpriced model
    // contributes neither spend nor a model-split entry.
    expect(testing.totalSpendUsd).toBe(30);
    // But it can't be ranked/tiered without a rate entry, so it's absent
    // from the model split.
    expect(testing.byModel).toHaveLength(0);
  });
});

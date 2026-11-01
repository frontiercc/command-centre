// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps Model Efficiency for ChatGPT and Codex: spend by kind of work and
// model, priced at OpenAI's USD token rates (ChatGPT each hour's cost shared
// across its replies, Codex per turn), unpriced models named, and a review
// flag naming only a cheaper model the same work already uses. Also the
// caching estimate counting OpenAI's cached input.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildModelEfficiency: typeof import('@/lib/finance/model-efficiency').buildModelEfficiency;
let buildChargeback: typeof import('@/lib/finance/chargeback').buildChargeback;

const NOW = Math.floor(Date.now() / 1000);
const MARCH = Math.floor(Date.UTC(2026, 2, 10) / 1000);
const PRO = 'gpt-6-pro';       // $10 in / $1 cached / $50 out per MTok
const TERRA = 'gpt-6.1-terra'; // $1 in / $0.05 cached / $5 out per MTok

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ buildModelEfficiency } = await import('@/lib/finance/model-efficiency'));
  ({ buildChargeback } = await import('@/lib/finance/chargeback'));
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u1', 'u1@test.local', 'u1', 'openai', ?, ?)`, [NOW, NOW]);

  // ChatGPT: six analysis conversations on gpt-6-pro, $10 each ($60), plus one on terra ($1).
  for (let i = 0; i < 7; i++) {
    const hour = MARCH + i * 3600;
    const sid = `chatgpt:s${i}`;
    const model = i < 6 ? PRO : TERRA;
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, surface, source) VALUES (?, ?, 'u1', 'cowork_user_message', ?, 'cowork', 'chatgpt_chat')`, [`${sid}-p`, sid, hour]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at) VALUES (?, 'u1', 2, 'analysis', 0.9, 'test', ?)`, [`${sid}-p`, hour]);
    await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, model, occurred_at) VALUES (?, 'u1', ?, 'chatgpt_chat', ?, ?)`, [`${sid}-r`, sid, model, hour + 60]);
    await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, billed_in) VALUES (?, 'u1', ?, 'chatgpt', ?, 1000000, 0, 0, 'usd')`, [`oc-${i}`, hour, model]);
  }
  // An unpriced ChatGPT model.
  await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, billed_in) VALUES ('oc-x', 'u1', ?, 'chatgpt', 'gpt-mystery', 5, 0, 0, 'usd')`, [MARCH + 9 * 3600]);

  // Codex: a feature session on terra with 2M cached input (saving 2 x ($1 - $0.05) = $1.90).
  await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens) VALUES ('ct1', 'u1', 'codex:a', ?, ?, 1000000, 2000000, 0)`, [TERRA, MARCH]);
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at) VALUES ('codex:a', 'u1', ?, ?, ?)`, [MARCH, MARCH + 600, MARCH]);
  await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at) VALUES ('codex:a', 'u1', 'feature', 2, 0.9, 'test', 'classified', ?)`, [MARCH]);
});

afterAll(async () => cleanup());

describe('Model Efficiency for OpenAI', () => {
  it('ChatGPT: spend by kind of work and model, unpriced named, flag stays with OpenAI', async () => {
    const r = await buildModelEfficiency('chatgpt', '2026-03', NOW);
    expect(r.surface).toBe('chatgpt');
    expect(r.hasData).toBe(true);
    expect(r.totals.spendUsd).toBeCloseTo(61, 6);
    expect(r.unpricedModels).toEqual(['gpt-mystery']);
    const analysis = r.activities.find(a => a.key === 'analysis')!;
    expect(analysis.byModel.map(m => m.model)).toEqual([PRO, TERRA]);
    // 6 sessions, $61, $60 on gpt-6-pro: flagged, pointing at terra, which the same work already uses.
    expect(analysis.flag).toMatchObject({ premiumModel: PRO, targetModel: TERRA, shareBasedOnly: true });
    expect(analysis.friction).toBeNull();
  });

  it('Codex: each turn priced, judged on the Code kinds of work', async () => {
    const r = await buildModelEfficiency('codex', '2026-03', NOW);
    expect(r.surface).toBe('codex');
    // 1M uncached x $1 + 2M cached x $0.05 = $1.10
    expect(r.totals.spendUsd).toBeCloseTo(1.1, 6);
    expect(r.activities.map(a => a.key)).toEqual(['feature']);
    expect(r.cacheEfficiency.cacheReadTokens).toBe(2_000_000);
  });

  it('Claude tabs see none of it', async () => {
    expect((await buildModelEfficiency('code', '2026-03', NOW)).hasData).toBe(false);
    expect((await buildModelEfficiency('cowork', '2026-03', NOW)).hasData).toBe(false);
  });

  it("the caching estimate counts OpenAI's cached input", async () => {
    const r = await buildChargeback('2026-03', NOW);
    expect(r.cacheSavingsUsd).toBeCloseTo(1.9, 6);
  });
});

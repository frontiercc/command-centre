// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse "By product" on Postgres with Claude Chat and ChatGPT: each has its
// own row, neither is counted as Cowork, the panel follows the vendor switch,
// and All products adds up to the headline of the view shown.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { buildByProduct } = await import('@/lib/pulse/cowork/by-product');
    const nowS = Math.floor(Date.now() / 1000);
    const t = nowS - 2 * 86400;

    for (const [id, email] of [['cw', 'cowork@example.com'], ['ch', 'chat@example.com'], ['gpt', 'gpt@example.com']]) {
      await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [id, email, id, t, t]);
    }
    const prompt = (id: string, session: string, user: string, surface: string, source: string) =>
      sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
               VALUES (?, ?, ?, 'cowork_user_message', ?, ?, 'text', ?)`, [id, session, user, surface, source, t]);
    const judge = (id: string, user: string, tier: number) =>
      sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
               VALUES (?, ?, ?, 'analysis', 0.9, 'test', ?)`, [id, user, tier, nowS]);

    // Claude Cowork: one session, five prompts (four Tier 2), with a reported cost.
    for (let i = 1; i <= 5; i++) { await prompt(`cw-${i}`, 'cw-s', 'cw', 'cowork', 'otel'); await judge(`cw-${i}`, 'cw', i === 1 ? 1 : 2); }
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, model, cost_usd, occurred_at)
                   VALUES ('cw-cost', 'cw-s', 'cw', 'cowork_api_request', 'cowork', 'otel', 'claude-sonnet-5', '2.5', ?)`, [t]);
    // Claude Chat: two conversations, five prompts all Tier 1.
    for (let i = 1; i <= 5; i++) { await prompt(`ch-${i}`, `ch-s${i % 2}`, 'ch', 'chat', 'compliance'); await judge(`ch-${i}`, 'ch', 1); }
    // ChatGPT: Work and Chat prompts (stored as surface 'cowork', product NULL), five judged, all Tier 3.
    for (let i = 1; i <= 3; i++) { await prompt(`gw-${i}`, 'chatgpt:w1', 'gpt', 'cowork', 'chatgpt_work'); await judge(`gw-${i}`, 'gpt', 3); }
    for (let i = 1; i <= 2; i++) { await prompt(`gc-${i}`, 'chatgpt:c1', 'gpt', 'cowork', 'chatgpt_chat'); await judge(`gc-${i}`, 'gpt', 3); }
    // ChatGPT spend: 1M input tokens of gpt-6.1-terra ($1/MTok) = $1.00; OpenAI's own $9.99 is not used.
    await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
                   VALUES ('oc-1', 'gpt', ?, 'chatgpt', 'gpt-6.1-terra', 1000000, 0, 0, 9.99, 'usd')`, [Math.floor(t / 3600) * 3600]);

    // All view with OpenAI connected: every row, ChatGPT last.
    const all = (await buildByProduct(nowS, { chatgpt: true }))!;
    expect(all.rows.map(r => r.product)).toEqual(['claude_chat', 'cowork', 'excel', 'word', 'powerpoint', 'outlook', 'sheets', 'docs', 'slides', 'chatgpt']);
    const row = (p: string) => all.rows.find(r => r.product === p)!;
    // Cowork is Claude's alone: ChatGPT's prompts and sessions are not in it.
    expect(row('cowork')).toMatchObject({ people: 1, sessions: 1, meaningfulPct: 80, spendUsd: 2.5, spendEstimated: false });
    expect(row('claude_chat')).toMatchObject({ people: 1, sessions: 2, meaningfulPct: 0, producedPct: null, spendUsd: null });
    expect(row('chatgpt')).toMatchObject({ people: 1, sessions: 2, meaningfulPct: 100, producedPct: null, spendEstimated: true });
    expect(row('chatgpt').spendUsd).toBeCloseTo(1, 6);
    // All products adds up, and its Meaningful work is the headline's: 9 of 15 judged prompts at Tier 2 or 3.
    expect(all.total.sessions).toBe(5);
    expect(all.total.people).toBe(3);
    expect(all.total.meaningfulPct).toBe(60);
    expect(all.total.spendUsd).toBeCloseTo(3.5, 6);

    // Claude view: Claude's rows only, and All products is Claude's: 4 of 10.
    const claude = (await buildByProduct(nowS, { vendor: 'claude', chatgpt: true }))!;
    expect(claude.rows.map(r => r.product)).not.toContain('chatgpt');
    expect(claude.total.sessions).toBe(3);
    expect(claude.total.meaningfulPct).toBe(40);
    expect(claude.total.spendUsd).toBeCloseTo(2.5, 6);

    // OpenAI view: the ChatGPT row alone.
    const openai = (await buildByProduct(nowS, { vendor: 'openai', chatgpt: true }))!;
    expect(openai.rows.map(r => r.product)).toEqual(['chatgpt']);
    expect(openai.total).toMatchObject({ sessions: 2, meaningfulPct: 100 });

    // OpenAI not connected (or hidden): no ChatGPT row, and the All view is Claude's.
    const noOpenai = (await buildByProduct(nowS))!;
    expect(noOpenai.rows.map(r => r.product)).not.toContain('chatgpt');
    expect(noOpenai.total.sessions).toBe(3);

    // Office and Google hidden on Admin → Work Pulse: their rows are left out.
    const noOffice = (await buildByProduct(nowS, { chatgpt: true, officeShown: false }))!;
    expect(noOffice.rows.map(r => r.product)).toEqual(['claude_chat', 'cowork', 'chatgpt']);

    // The briefings' "where the work happened" never counts ChatGPT as Cowork.
    const { readWorkByProduct } = await import('@/lib/pulse/briefings/work-by-product');
    expect(await readWorkByProduct(null, nowS - 30 * 86400, nowS + 1)).toEqual([{ product: 'cowork', sessions: 1, people: 1 }]);
  } finally {
    await cleanup();
  }
}

describe('by product with Claude Chat and ChatGPT (postgres)', () => {
  it('gives Claude Chat and ChatGPT their own rows and follows the vendor switch', async () => {
    await runSpec();
  }, 180_000);
});

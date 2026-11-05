// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse "By product" figures on Postgres: Cowork beside Claude in Office.
// Office rows come from the masked real capture (test/fixtures/office-agent-capture.jsonl),
// re-timed to now so they fall inside the 14-day window.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const nowNano = BigInt(Math.floor(Date.now() / 1000)) * BigInt(1_000_000_000);

/** The capture with every span moved to "now", keeping each span's length. */
function capture() {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-agent-capture.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  let first: bigint | null = null;
  for (const l of lines) for (const rs of l.resourceSpans) for (const ss of rs.scopeSpans) for (const sp of ss.spans) {
    const s = BigInt(sp.startTimeUnixNano);
    if (first === null || s < first) first = s;
  }
  for (const l of lines) for (const rs of l.resourceSpans) for (const ss of rs.scopeSpans) for (const sp of ss.spans) {
    sp.startTimeUnixNano = String(BigInt(sp.startTimeUnixNano) - first! + nowNano - BigInt(3600) * BigInt(1_000_000_000));
    sp.endTimeUnixNano = String(BigInt(sp.endTimeUnixNano) - first! + nowNano - BigInt(3600) * BigInt(1_000_000_000));
  }
  return lines;
}

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { processOfficeSpans } = await import('@/lib/otel/office-receiver');
    const { buildByProduct } = await import('@/lib/pulse/cowork/by-product');

    // No Office activity yet: the panel still shows every product, at zero, and says so.
    const empty = (await buildByProduct())!;
    expect(empty.hasOffice).toBe(false);
    expect(empty.rows.map(r => r.product)).toEqual(['cowork', 'excel', 'word', 'powerpoint', 'outlook']);
    for (const r of empty.rows) expect(r).toMatchObject({ people: 0, sessions: 0, meaningfulPct: null, producedPct: null, spendUsd: null });

    // A Cowork user with a reported cost, two days ago.
    const nowS = Math.floor(Date.now() / 1000);
    const t = nowS - 2 * 86400;
    await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('cw-user', 'cowork.person@example.com', 'Cowork Person', ?, ?)`, [t, t]);
    await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES ('cw-s1', 'cw-s1', 'cw-user', 'otel', ?)`, [t]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at) VALUES ('cw-m1', 'cw-s1', 'cw-user', 'cowork_user_message', 'cowork', 'otel', 'Draft the board note', ?)`, [t]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, model, cost_usd, occurred_at) VALUES ('cw-m2', 'cw-s1', 'cw-user', 'cowork_api_request', 'cowork', 'otel', 'claude-sonnet-5', '1.25', ?)`, [t]);

    for (const line of capture()) expect((await processOfficeSpans(line)).errors).toEqual([]);

    // Office spend is priced from the built-in Opus 5.5 rate, as an estimate.
    let rows = (await buildByProduct())!.rows;
    expect(rows.map(r => r.product)).toEqual(['cowork', 'excel', 'word', 'powerpoint', 'outlook']);
    expect(rows.find(r => r.product === 'outlook')).toMatchObject({ people: 0, sessions: 0, spendUsd: null });
    const cowork = rows.find(r => r.product === 'cowork')!;
    expect(cowork).toMatchObject({ people: 1, sessions: 1, spendUsd: 1.25, spendEstimated: false });
    const word = rows.find(r => r.product === 'word')!;
    expect(word).toMatchObject({ people: 1, sessions: 1, spendEstimated: true });
    expect(word.spendUsd).toBeGreaterThan(0);
    expect(word.unpricedModels).toEqual([]);
    // Too few sessions to give a rate, and nothing classified yet: blank, never 0.
    expect(word.producedPct).toBeNull();
    expect(word.meaningfulPct).toBeNull();

    // A model with no rate is left out and named, never counted as $0.
    const { DEFAULT_RATES } = await import('@/lib/pulse/code/rates');
    const saved = DEFAULT_RATES['claude-opus-5-5'];
    delete DEFAULT_RATES['claude-opus-5-5'];
    try {
      rows = (await buildByProduct())!.rows;
      const unpriced = rows.find(r => r.product === 'word')!;
      expect(unpriced.spendUsd).toBeNull();
      expect(unpriced.unpricedModels).toEqual(['claude-opus-5-5']);
    } finally {
      DEFAULT_RATES['claude-opus-5-5'] = saved;
    }
    rows = (await buildByProduct())!.rows;
    expect(rows.find(r => r.product === 'cowork')!.spendUsd).toBe(1.25);

    // Meaningful work reads the classifier's tiers per product.
    const wordPrompt = await sql.get<{ id: string; user_id: string }>(`SELECT id, user_id FROM cowork_messages WHERE product = 'word' AND message_type = 'cowork_user_message' LIMIT 1`);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at) VALUES (?, ?, 3, 'analysis', 0.9, 'test', ?)`, [wordPrompt!.id, wordPrompt!.user_id, nowS]);
    // A Cowork prompt at Tier 1 too, so All products differs from each product.
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at) VALUES ('cw-m1', 'cw-user', 1, 'basic_drafting', 0.9, 'test', ?)`, [nowS]);
    const built = (await buildByProduct())!;
    rows = built.rows;
    // One judged prompt each: too few, so blank rather than 100% or 0%.
    expect(rows.find(r => r.product === 'word')!.meaningfulPct).toBeNull();
    expect(rows.find(r => r.product === 'cowork')!.meaningfulPct).toBeNull();
    expect(rows.find(r => r.product === 'excel')!.meaningfulPct).toBeNull();

    // All products: people and sessions counted once; meaningful work equals the
    // overview headline's own calculation; spend adds up.
    const headline = await sql.get<{ pct: number }>(
      `SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE tier >= 2) / COUNT(*)) AS pct FROM pulse_classifications WHERE classified_at >= ? AND classifier_status = 'classified'`,
      [nowS - 30 * 86400]);
    expect(built.total.meaningfulPct).toBe(Number(headline!.pct));
    expect(built.total.meaningfulPct).toBe(50);
    // App users: once per product used (the Office person used three apps), so the column adds up.
    expect(built.total.people).toBe(rows.reduce((n, r) => n + r.people, 0));
    expect(built.total.people).toBe(4);
    expect(built.total.sessions).toBe(rows.reduce((n, r) => n + r.sessions, 0));
    // Spend: Cowork's reported cost plus the Office estimate, marked as an estimate.
    expect(built.total.spendUsd).toBeCloseTo(rows.reduce((n, r) => n + (r.spendUsd ?? 0), 0), 6);
    expect(built.total.spendUsd!).toBeGreaterThan(1.25);
    expect(built.total.spendEstimated).toBe(true);

    // Produced something counts the sessions in the Sessions column only. Five
    // Cowork sessions with a prompt, two of which produced something, plus 40
    // stats rows for sessions with no prompt (as a demo hub has): 40%, not 4%.
    for (let i = 2; i <= 5; i++) {
      await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES (?, ?, 'cw-user', 'otel', ?)`, [`cw-s${i}`, `cw-s${i}`, t]);
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at) VALUES (?, ?, 'cw-user', 'cowork_user_message', 'cowork', 'otel', 'Next task', ?)`, [`cw-p${i}`, `cw-s${i}`, t]);
    }
    for (let i = 1; i <= 5; i++) {
      await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, produced_output, computed_at) VALUES (?, 'cw-user', ?, ?, ?)`, [`cw-s${i}`, t, i <= 2 ? 1 : 0, nowS]);
    }
    for (let i = 1; i <= 40; i++) {
      await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES (?, ?, 'cw-user', 'otel', ?)`, [`np-${i}`, `np-${i}`, t]);
      await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, produced_output, computed_at) VALUES (?, 'cw-user', ?, 0, ?)`, [`np-${i}`, t, nowS]);
    }
    const withOutput = (await buildByProduct())!;
    expect(withOutput.rows.find(r => r.product === 'cowork')).toMatchObject({ sessions: 5, producedPct: 40 });
    expect(withOutput.total.producedPct).toBe(40);

    // Five judged Cowork prompts (one Tier 1, four Tier 2): Cowork's share shows.
    for (let i = 2; i <= 5; i++) {
      await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at) VALUES (?, 'cw-user', 2, 'analysis', 0.9, 'test', ?)`, [`cw-p${i}`, nowS]);
    }
    const judged = (await buildByProduct())!;
    expect(judged.rows.find(r => r.product === 'cowork')!.meaningfulPct).toBe(80);
    expect(judged.rows.find(r => r.product === 'word')!.meaningfulPct).toBeNull();
    expect(judged.total.meaningfulPct).toBe(83);

    // The briefings' "where the work happened" reads the same sessions, per department.
    const { readWorkByProduct, workByProductFacts } = await import('@/lib/pulse/briefings/work-by-product');
    const all = await readWorkByProduct(null, nowS - 30 * 86400, nowS + 1);
    expect(all.find(a => a.product === 'cowork')).toEqual({ product: 'cowork', sessions: 5, people: 1 });
    expect(all.find(a => a.product === 'word')).toEqual({ product: 'word', sessions: 1, people: 1 });
    expect(await readWorkByProduct(['cw-user'], nowS - 30 * 86400, nowS + 1)).toEqual([{ product: 'cowork', sessions: 5, people: 1 }]);
    expect((await workByProductFacts(null, nowS - 30 * 86400, nowS + 1))[0]).toMatch(/^Where the work happened/);
    expect(await workByProductFacts(['cw-user'], nowS - 30 * 86400, nowS + 1)).toEqual([]);
    // Hidden on Admin → Work Pulse: the briefings say nothing about Office.
    await sql.run(`INSERT INTO config (key, value) VALUES ('claude_in_office_shown', 'false') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    expect(await workByProductFacts(null, nowS - 30 * 86400, nowS + 1)).toEqual([]);
  } finally {
    await cleanup();
  }
}

describe('work pulse by product (postgres)', () => {
  it('compares Cowork with each Office app, keeping Office spend a separate estimate', async () => {
    await runSpec();
  }, 180_000);
});

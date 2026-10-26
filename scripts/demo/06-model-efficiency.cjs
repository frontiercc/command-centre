// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Reversible demo seeder for the FinOps "Model efficiency" COWORK surface.
//
// The model-efficiency Cowork view joins task_type (pulse_classifications, which
// tags cowork_user_message rows) to spend (cowork_api_request rows) BY SESSION.
// Real seed data rarely has both in the same session, so the Cowork view shows
// everything as "Unclassified". This seeder creates a handful of sessions that
// each carry: a classified cowork_user_message (→ pulse_classifications task_type)
// + priced cowork_api_request rows (model + cost_usd + token_usage) sharing the
// session_id — so the Cowork cross-tab populates with real task types, model
// splits, and one flagged "worth reviewing" opportunity.
//
// Postgres only. Idempotent: every row
// carries the marker prefix `seedme-cwme-`, so re-running cleans first.
//
//   node scripts/demo/06-model-efficiency.cjs           # seed (cleans first)
//   node scripts/demo/06-model-efficiency.cjs --clean   # remove seeded rows only
//
// Run in-container:  docker cp scripts/demo/06-model-efficiency.cjs ccc-hub:/app/ \
//                    && docker exec ccc-hub node /app/06-model-efficiency.cjs

const { Client } = require('pg');

const MARKER = 'seedme-cwme-';
const CLEAN_ONLY = process.argv.includes('--clean');

// $/MTok — must match lib/pulse/code/rates.ts DEFAULT_RATES for these exact keys
// so priceTokens() prices them (model split + tiering + ceiling all work).
const RATES = {
  'claude-opus-4-8':            { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6':            { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6':          { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001':  { in: 1, out: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
};
const price = (model, u) => {
  const r = RATES[model]; const M = 1e6;
  return (u.inputTokens / M) * r.in + (u.outputTokens / M) * r.out
       + (u.cacheCreationTokens / M) * r.cacheWrite + (u.cacheReadTokens / M) * r.cacheRead;
};
const round2 = (n) => Math.round(n * 100) / 100;

// Token bundles sized to hit target spends.
const BIG_OPUS   = { inputTokens: 200000, outputTokens: 250000, cacheReadTokens: 60000, cacheCreationTokens: 12000 }; // ~$7.3
const MED_SONNET = { inputTokens: 120000, outputTokens: 130000, cacheReadTokens: 40000, cacheCreationTokens: 8000 };  // ~$2.4
const BIG_SONNET = { inputTokens: 220000, outputTokens: 210000, cacheReadTokens: 80000, cacheCreationTokens: 15000 }; // ~$3.9
const SM_OPUS    = { inputTokens: 30000,  outputTokens: 20000,  cacheReadTokens: 10000, cacheCreationTokens: 4000 };  // ~$0.7
const SM_HAIKU   = { inputTokens: 150000, outputTokens: 120000, cacheReadTokens: 50000, cacheCreationTokens: 10000 }; // ~$0.8

// Per group: task_type, tier, session count, and the api_request rows per session.
//
// task_type MUST be a name from the rubric taxonomy (lib/pulse/tier-config.ts).
// These were free text ('Client reporting', 'Research synthesis', 'Meeting
// notes') once, which invented three categories that then showed up
// on every surface grouping by task_type — Work Mix, the session output rate
// breakdown, this cross-tab — with no admin able to find where they came from.
// The Cowork classifier now rejects off-taxonomy values outright; a seeder
// writing straight to the table bypasses that check, so it has to hold the line
// itself.
const GROUPS = [
  // Opus-heavy + enough volume → "Worth reviewing" (share-based). Opus ≈ 78% of spend.
  //
  // Two constraints this group has to hold, both learned by breaking it:
  //   - its task_type must be one NO other seeder emits. It was
  //     structured_report until 07-attribution.cjs began attributing real
  //     spend to that same type; the groups merged, the premium share fell
  //     below the 40% floor, and the one flagged opportunity on the Cowork
  //     surface silently became "Efficient".
  //   - it must use the priciest model id actually in the instance's mix
  //     (claude-opus-4-8). The flag measures the share held by the TOP-RANKED
  //     model; opus-4-6 and opus-4-8 carry identical list rates, so with both
  //     present the ranking tie-breaks arbitrarily and the share splits.
  { taskType: 'capability_creation', tier: 3, sessions: 6,
    rows: [{ model: 'claude-opus-4-8', u: BIG_OPUS }, { model: 'claude-sonnet-4-6', u: MED_SONNET }] },
  // Sonnet-led, above volume but low premium share → "Efficient".
  { taskType: 'research_brief', tier: 2, sessions: 7,
    rows: [{ model: 'claude-sonnet-4-6', u: BIG_SONNET }, { model: 'claude-opus-4-6', u: SM_OPUS }] },
  // Small → "Low volume".
  { taskType: 'summarisation', tier: 1, sessions: 3,
    rows: [{ model: 'claude-haiku-4-5-20251001', u: SM_HAIKU }] },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable'
    ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    // Clean (idempotent) — child table first.
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [MARKER + '%']);
    // A LIVE instance's pulse pipeline may have attached pulse_events /
    // pulse_skill_runs to earlier marker messages (both FK cowork_messages.id,
    // no cascade) — delete them too, and match by message id AND session-id
    // prefix (messages are keyed seedme-cwme-um-N but classified children key
    // on the message id). Found on a demo install.
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1 OR cowork_message_id IN (SELECT id FROM cowork_messages WHERE session_id LIKE $1)`, [MARKER + '%']);
    await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1 OR cowork_message_id IN (SELECT id FROM cowork_messages WHERE session_id LIKE $1)`, [MARKER + '%']);
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id IN (SELECT id FROM cowork_messages WHERE session_id LIKE $1)`, [MARKER + '%']);
    const del = await c.query(`DELETE FROM cowork_messages WHERE session_id LIKE $1`, [MARKER + '%']);
    console.log(`cleaned ${del.rowCount} seeded cowork_messages`);
    if (CLEAN_ONLY) return;

    // Attribute to existing departmented users so spend flows to real cost centres,
    // not "Unallocated". Fall back to any users, then to a marker user.
    let users = (await c.query(
      `SELECT id FROM users WHERE department IS NOT NULL ORDER BY id LIMIT 4`)).rows.map(r => r.id);
    if (users.length === 0) users = (await c.query(`SELECT id FROM users ORDER BY id LIMIT 4`)).rows.map(r => r.id);
    if (users.length === 0) users = [MARKER + 'user'];

    // Current-month timestamps (calendar-month window the view uses).
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // Clamp to NOW — day offsets past today's date must never mint
    // future-dated telemetry (a future occurred_at stretched the dashboard's
    // 14-day adoption chart out to the end of the month — found on
    // a demo install).
    // Spread across the part of the month that has passed (never the future). Clamping fixed day
    // offsets to now piled every not-yet-reached session onto one timestamp early in the month,
    // which looked like a one-day spike and inflated the FinOps run rate.
    const nowMinus1h = Date.now() - 3600_000;
    const tsFor = (slot) => Math.floor((monthStart + ((slot + 0.5) / 22) * Math.max(0, nowMinus1h - monthStart)) / 1000);

    let sessionN = 0, apiRows = 0, totalUsd = 0;
    const summary = {};
    for (const g of GROUPS) {
      summary[g.taskType] = 0;
      for (let s = 0; s < g.sessions; s++) {
        sessionN++;
        const sid = `${MARKER}sess-${sessionN}`;
        const umId = `${MARKER}um-${sessionN}`;
        const uid = users[sessionN % users.length];
        const ts = tsFor(sessionN % 22); // spread across the month so far

        // 1) the classified user message — realistic prompt matching the task
        // type (not a "[seed] … session" placeholder), so the audit log reads
        // like genuine usage. Rotates through a small per-task-type pool.
        const TASK_PROMPTS = {
          'capability_creation': [
            'Build the Q1 client performance report from these figures.',
            'Draft the monthly client update with the key metrics.',
            'Summarise this account’s health into a one-page review.',
          ],
          'research_brief': [
            'Synthesise these five interview transcripts into themes.',
            'Pull the key findings from this market research into a brief.',
            'Compare these vendor evaluations and recommend one.',
          ],
          'summarisation': [
            'Turn this meeting transcript into notes and action items.',
            'Summarise today’s standup into decisions and follow-ups.',
            'Extract the action items from this call recording.',
          ],
        };
        // Keyed on g.taskType — these MUST stay in step with GROUPS above. They
        // were keyed on the old free-text names ('Client reporting' etc.) and
        // when the groups moved to taxonomy values the lookup missed silently,
        // so the fallback wrote the TASK TYPE ITSELF as the user's prompt and
        // the Audit Log showed rows whose entire prompt read "summarisation".
        // Fail loudly rather than write a prompt no human would type.
        const tp = TASK_PROMPTS[g.taskType];
        if (!tp) throw new Error(`no prompts defined for task type "${g.taskType}" — add them to TASK_PROMPTS`);
        await c.query(
          `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, source, surface, content_preview)
           VALUES ($1,$2,$3,'cowork_user_message',$4,'otel','cowork',$5)`,
          [umId, sid, uid, ts, tp[sessionN % tp.length]]);
        // 2) its classification (task_type)
        await c.query(
          `INSERT INTO pulse_classifications
             (cowork_message_id, user_id, tier, task_type, frontier_push_candidate,
              capability_creation_candidate, classifier_confidence, classifier_model,
              classifier_status, classifier_attempts, classified_at)
           VALUES ($1,$2,$3,$4,0,0,0.8,'claude-haiku-4-5-20251001','classified',1,$5)`,
          [umId, uid, g.tier, g.taskType, ts]);
        // 3) the priced api_request spend rows in the same session
        let j = 0;
        for (const row of g.rows) {
          j++;
          const cost = round2(price(row.model, row.u));
          totalUsd += cost;
          apiRows++;
          summary[g.taskType] += cost;
          await c.query(
            `INSERT INTO cowork_messages
               (id, session_id, user_id, message_type, model, cost_usd, token_usage, occurred_at, source, surface)
             VALUES ($1,$2,$3,'cowork_api_request',$4,$5,$6::jsonb,$7,'otel','cowork')`,
            [`${MARKER}req-${sessionN}-${j}`, sid, uid, row.model, cost, JSON.stringify(row.u), ts]);
        }
      }
    }
    console.log(`seeded ${sessionN} sessions, ${apiRows} api_request rows, $${round2(totalUsd)} total`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: $${round2(v)}`);
    console.log(`attributed to users: ${users.join(', ')}`);
  } finally {
    await c.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Reversible demo seeder for a demo install — gives every SEEDED Cowork
// session that carries a prompt but no spend row one priced
// `cowork_api_request` row, so the Audit Log's "Session Stats (OTel)" pane
// shows cost / tokens / model the way it does for real telemetry on
// a production deployment.
//
// Measured first on a demo install's own audit feed (latest 300 rows per
// surface): the Cowork prompt rows the older seeders wrote (ff-cw, ff5-anchor,
// ff5-cw, ff6-*) render a Session Stats box with no cost and no model, because
// the live session aggregator (lib/pulse/cowork/session-aggregator.ts) derives
// those three things from `cowork_api_request` rows in the same session, and
// those sessions never got one. The Code prompt rows already carried stats, and
// the skill/connector invocation events carry none anywhere (the audit's
// invocation query does not join stats, on real data too), so this is Cowork
// only.
//
// What it does, in order, every run:
//   1. Deletes its own rows (`ff10-` prefix) and resets computed_at on the
//      sessions it touched last time, so a re-run never double-prices.
//   2. For each seeded Cowork session (message id prefix in SEEDED_PREFIXES)
//      with a `cowork_user_message` and no `cowork_api_request`, inserts ONE
//      api_request row: model (Sonnet 5 mostly, some Haiku — never Opus, so no
//      seeded group gains premium share in FinOps model efficiency), token
//      usage, cost at list rates, in the exact "<model> | {json}" preview
//      shape the aggregator parses. Deterministic per session id.
//   3. Sets computed_at = 0 on those sessions' cowork_session_stats rows so
//      the hourly aggregator recomputes them (its candidate rule is
//      computed_at < newest message; computed_at is stamped `now` at
//      aggregation, so a back-dated api row alone would not qualify).
//
// Runs after the other sample scripts (see the order in load.cjs): every earlier seeder must have written its
// prompts first. Cost is deliberately modest (about $0.05–0.35 a session) —
// it lands in FinOps' Cowork spend, so the totals there rise a little.
//
// Run (inside the hub container): docker exec -i ccc-hub node < scripts/demo/08-session-stats.cjs
//      SEED_CLEAN=1 ...   # clean only
// Locally: CCC_PG_SSL=disable DATABASE_URL=postgresql://... node scripts/demo/08-session-stats.cjs [--clean]
'use strict';
const { Client } = require('pg');

const CLEAN_ONLY = process.argv.includes('--clean') || process.env.SEED_CLEAN === '1';
const MARKER = 'ff10-';
// Message-id prefixes the other sample scripts use. ff9- (skill
// workflows) is excluded by the NOT EXISTS below anyway — it already writes
// its own api_request row per session.
const SEEDED_PREFIXES = ['ff-', 'ff2-', 'ff3-', 'ff4-', 'ff5-', 'ff6-', 'ff7-', 'ff8-', 'ff9-', 'seedme-'];

const MODELS = ['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
// List rates per million tokens: [input, output, cache_read].
const RATES = { 'claude-sonnet-5': [3, 15, 0.3], 'claude-haiku-4-5-20251001': [1, 5, 0.1] };

function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

async function clean(c) {
  const touched = await c.query(`SELECT DISTINCT session_id FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
  const ids = touched.rows.map(r => r.session_id);
  await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
  if (ids.length > 0) {
    await c.query(`UPDATE cowork_session_stats SET computed_at = 0 WHERE session_id = ANY($1::text[])`, [ids]);
  }
  return ids.length;
}

async function seed(c) {
  const nowS = Math.floor(Date.now() / 1000);
  const likeAny = SEEDED_PREFIXES.map((_, i) => `m.id LIKE $${i + 1}`).join(' OR ');
  const params = SEEDED_PREFIXES.map(p => `${p}%`);
  const { rows } = await c.query(
    `SELECT m.session_id, MAX(m.user_id) AS user_id, MAX(m.occurred_at) AS last_at, COUNT(*) AS prompts
     FROM cowork_messages m
     WHERE m.surface = 'cowork' AND m.message_type = 'cowork_user_message' AND m.session_id IS NOT NULL
       AND (${likeAny})
       AND NOT EXISTS (SELECT 1 FROM cowork_messages a WHERE a.session_id = m.session_id AND a.message_type = 'cowork_api_request')
     GROUP BY m.session_id`, params);

  let inserted = 0;
  const touched = [];
  for (const r of rows) {
    const h = hash(r.session_id);
    const model = MODELS[h % MODELS.length];
    const prompts = Number(r.prompts) || 1;
    const input = (6000 + (h % 14000)) * Math.min(prompts, 4);
    const output = (900 + ((h >> 3) % 2600)) * Math.min(prompts, 4);
    const cacheRead = ((h >> 7) % 3 === 0) ? 0 : 8000 + ((h >> 9) % 40000);
    const [ri, ro, rc] = RATES[model];
    const cost = (input * ri + output * ro + cacheRead * rc) / 1e6;
    const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 };
    // Never future-dated (the seeders' standing rule): the row sits 30s after
    // the last prompt, capped at now.
    const at = Math.min(Number(r.last_at) + 30, nowS);
    await c.query(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, ingested_at, model, cost_usd, token_usage, content_preview, source)
       VALUES ($1,$2,$3,'cowork_api_request','cowork',$4,$4,$5,$6,$7::jsonb,$8,'otel') ON CONFLICT (id) DO NOTHING`,
      [`${MARKER}api-${r.session_id}`, r.session_id, r.user_id, at, model, cost.toFixed(6), JSON.stringify(usage), `${model} | ${JSON.stringify(usage)}`]);
    inserted++;
    touched.push(r.session_id);
  }
  if (touched.length > 0) {
    await c.query(`UPDATE cowork_session_stats SET computed_at = 0 WHERE session_id = ANY($1::text[])`, [touched]);
  }
  const spend = await c.query(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
  console.log(`[sample-session-stats] priced ${inserted} seeded Cowork sessions (about $${Number(spend.rows[0].usd).toFixed(2)} total); stats recompute on the aggregator's next hourly pass (or POST /api/pulse/cowork/aggregate).`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable'
    ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    const reset = await clean(c);
    if (CLEAN_ONLY) {
      console.log(`[sample-session-stats] clean: removed ${MARKER} rows, reset ${reset} sessions for recompute.`);
      return;
    }
    await seed(c);
    console.log('[sample-session-stats] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

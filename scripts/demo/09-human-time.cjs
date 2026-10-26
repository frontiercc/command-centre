// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Demo seeder for a demo install — human time vs Claude time
//
// The sample scripts recreate the demo sessions on every load, and the seeded
// Cowork sessions are only a minute or two long, so letting the real estimator
// run would (a) re-estimate ~2,000 sessions a day (about $100 a month of Haiku)
// and (b) compare hours of by-hand work against a couple of minutes, showing
// the inflated ~80x ratio localhost did. Instead, for SEEDED Tier 2/3 sessions
// only (a prompt row with a seeded id prefix):
//
//   1. Realistic Claude time (Cowork 8-70 min, Code 20-130 min, by tier;
//      deterministic per session). Written straight onto the stats row so the
//      cards are right at once, AND backed by evenly spaced events so the real
//      aggregators land on the same figure when they rebuild the session (ff10-
//      resets thousands of sessions each morning; the Cowork aggregator drains
//      500 an hour). The events are chosen so no other card moves:
//        Cowork: `cowork_tool_summary` rows. The Audit Log and the export hide
//          that type, and nothing but the aggregator's timing reads it (not
//          Top native tools, which reads tool_metadata; not Model Mix, which
//          reads api_request; not Session Output Rate).
//        Code: zero-token rows with an EMPTY model name, the receiver's own
//          "not a model call" sentinel, so every turn, model and spend reader
//          skips them (Model Mix, FinOps spend by model, subagent share, session
//          model lists) while active time still sees their timestamps. They
//          used to say claude-sonnet-5, which showed a phantom "Claude Sonnet 5,
//          0 tokens, 6,128 turns" in Model Mix (now fixed).
//      The only side effect is a small rise in raw event counts.
//   2. A by-hand estimate in the proportions real data shows: Cowork about
//      2.5-4.5x the Claude time by kind of work (a first real run
//      read ~3.2x; quick jobs higher), Code about 2-3x. The aggregators never write those columns.
//
// With every seeded Tier 2/3 session estimated, the real estimate jobs find
// nothing to do, so humanTimeEnabled costs no API calls for the demo data. The
// spot-check is left alone (the card says "not yet checked").
//
// Each run first removes its own ff11- rows and clears the estimates it wrote
// (marked human_minutes_attempts = SEEDED_MARK; the real jobs only retry below
// 3, so they leave those alone). Runs after the other sample scripts (see the order in load.cjs), after ff10-.
//
// Run (inside the hub container): docker exec -i ccc-hub node < scripts/demo/09-human-time.cjs
//      SEED_CLEAN=1 ...   # clean only
// Locally: CCC_PG_SSL=disable DATABASE_URL=postgresql://... node scripts/demo/09-human-time.cjs [--clean]
'use strict';
const { Client } = require('pg');

const CLEAN_ONLY = process.argv.includes('--clean') || process.env.SEED_CLEAN === '1';
const MARKER = 'ff11-';
const SEEDED_MARK = 99;
const SEEDED_PREFIXES = ['ff-', 'ff2-', 'ff3-', 'ff4-', 'ff5-', 'ff6-', 'ff7-', 'ff8-', 'ff9-', 'seedme-'];
const WINDOW_DAYS = 60;

// Chosen so the sample reads like real data: by-hand time a few times the
// Claude time.
const COWORK_FACTOR = {
  structured_report: [3.5, 4.5], analysis: [3, 4.5], synthesis: [3, 4], capability_creation: [3.5, 4.5],
  autonomous_workflow: [3, 4.5], multi_file_operation: [2.5, 3.5], basic_drafting: [2.5, 4], summarisation: [2.5, 3.5],
};
const DEFAULT_COWORK_FACTOR = [2.5, 4];
const CODE_FACTOR = [2, 3.2];

function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function pick(id, salt, lo, hi) { return lo + ((hash(`${salt}:${id}`) % 10000) / 10000) * (hi - lo); }
const round15 = (m) => Math.max(15, Math.round(m / 15) * 15);

function estimate(id, minutes, [flo, fhi], quickBoost) {
  let f = pick(id, 'f', flo, fhi);
  if (quickBoost && minutes < 12) f += 1.5; // quick jobs read as a bigger multiple
  const likely = Math.min(2400, round15(minutes * f));
  const low = Math.min(likely, round15(likely * 0.6));
  const high = Math.min(2400, Math.max(likely, round15(likely * 1.6)));
  return { low, likely, high };
}

/** Evenly spaced event times from t0 over `minutes`, never past now. */
function eventTimes(id, t0, minutes, stepLo, stepHi, nowS) {
  const end = Math.min(t0 + minutes * 60, nowS - 60);
  const out = [];
  let t = t0;
  for (let i = 0; i < 200; i++) {
    t += Math.round(pick(id, `s${i}`, stepLo, stepHi) * 60);
    if (t > end) break;
    out.push(t);
  }
  const last = out.length ? out[out.length - 1] : t0;
  return { times: out, minutes: Math.floor((last - t0) / 60) };
}

function seededFilter(alias, firstParam) {
  return SEEDED_PREFIXES.map((_, i) => `${alias}.id LIKE $${firstParam + i}`).join(' OR ');
}
const prefixParams = SEEDED_PREFIXES.map(p => `${p}%`);

async function clean(c) {
  await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM code_assistant_meta WHERE id LIKE $1`, [`${MARKER}%`]);
  const cw = await c.query(`UPDATE cowork_session_stats SET computed_at = 0, human_minutes_low = NULL, human_minutes_likely = NULL,
    human_minutes_high = NULL, human_minutes_attempts = 0 WHERE human_minutes_attempts = $1`, [SEEDED_MARK]);
  const cd = await c.query(`UPDATE code_session_classifications SET human_minutes_low = NULL, human_minutes_likely = NULL,
    human_minutes_high = NULL, human_minutes_attempts = 0 WHERE human_minutes_attempts = $1 RETURNING session_id`, [SEEDED_MARK]);
  if (cd.rows.length) {
    await c.query(`UPDATE code_session_stats SET computed_at = 0 WHERE session_id = ANY($1::text[])`, [cd.rows.map(r => r.session_id)]);
  }
  return { cowork: cw.rowCount, code: cd.rows.length };
}

async function seed(c) {
  const nowS = Math.floor(Date.now() / 1000);
  const since = nowS - WINDOW_DAYS * 86400;

  const cowork = (await c.query(`
    SELECT m.session_id, min(m.occurred_at) AS t0, max(pc.tier) AS tier,
      (array_agg(pc.task_type ORDER BY pc.tier DESC, m.occurred_at))[1] AS kind
    FROM cowork_messages m
    JOIN pulse_classifications pc ON pc.cowork_message_id = m.id AND pc.classifier_status = 'classified'
    JOIN cowork_session_stats s ON s.session_id = m.session_id
    WHERE m.message_type = 'cowork_user_message' AND (m.surface = 'cowork' OR m.surface IS NULL)
      AND m.occurred_at >= $1 AND (${seededFilter('m', 2)})
    GROUP BY m.session_id HAVING max(pc.tier) >= 2`, [since, ...prefixParams])).rows;

  let cw = 0;
  for (const r of cowork) {
    const id = r.session_id;
    const target = Number(r.tier) === 3 ? pick(id, 'm', 15, 70) : pick(id, 'm', 8, 30);
    const { times, minutes } = eventTimes(id, Number(r.t0), target, 3, 9, nowS);
    if (minutes < 3) continue;
    const owner = (await c.query(`SELECT user_id FROM cowork_session_stats WHERE session_id = $1`, [id])).rows[0]?.user_id;
    for (let k = 0; k < times.length; k++) {
      // source 'otel': the session aggregator only reads OTel rows.
      await c.query(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
        VALUES ($1, $2, $3, 'cowork_tool_summary', 'cowork', 'otel', $4) ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}cw-${id}-${k}`, id, owner, times[k]]);
    }
    const e = estimate(id, minutes, COWORK_FACTOR[r.kind] ?? DEFAULT_COWORK_FACTOR, true);
    await c.query(`UPDATE cowork_session_stats SET active_secs = GREATEST(COALESCE(active_secs, 0), $2),
      human_minutes_low = $3, human_minutes_likely = $4, human_minutes_high = $5, human_minutes_attempts = $6
      WHERE session_id = $1`, [id, minutes * 60, e.low, e.likely, e.high, SEEDED_MARK]);
    cw++;
  }

  const code = (await c.query(`
    SELECT s.session_id, s.user_id, s.first_at AS t0, k.tier
    FROM code_session_stats s
    JOIN code_session_classifications k ON k.session_id = s.session_id AND k.status = 'classified' AND k.tier IN (2, 3)
    WHERE s.first_at >= $1
      -- A seeded Code session is recognised by its own id (most carry no prompt
      -- row: on a demo install only 9 of Engineering's 86 Tier 2/3 sessions did).
      AND ((${SEEDED_PREFIXES.map((_, i) => `s.session_id LIKE $${i + 2}`).join(' OR ')})
        OR EXISTS (SELECT 1 FROM cowork_messages m WHERE m.session_id = s.session_id AND (${seededFilter('m', 2)})))`,
    [since, ...prefixParams])).rows;

  let cd = 0;
  for (const r of code) {
    const id = r.session_id;
    const target = Number(r.tier) === 3 ? pick(id, 'm', 45, 130) : pick(id, 'm', 20, 70);
    const { times, minutes } = eventTimes(id, Number(r.t0), target, 2, 6, nowS);
    if (minutes < 3) continue;
    for (let k = 0; k < times.length; k++) {
      await c.query(`INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, tool_use_count, error_count, commit_count, source, occurred_at)
        VALUES ($1, $2, $3, '', 0, 0, 0, 0, 0, 'otel', $4) ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}cd-${id}-${k}`, r.user_id, id, times[k]]);
    }
    const e = estimate(id, minutes, CODE_FACTOR, false);
    await c.query(`UPDATE code_session_stats SET active_secs = GREATEST(COALESCE(active_secs, 0), $2) WHERE session_id = $1`, [id, minutes * 60]);
    await c.query(`UPDATE code_session_classifications SET human_minutes_low = $2, human_minutes_likely = $3,
      human_minutes_high = $4, human_minutes_attempts = $5 WHERE session_id = $1`, [id, e.low, e.likely, e.high, SEEDED_MARK]);
    cd++;
  }
  return { cowork: cw, code: cd };
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('[sample-human-time] DATABASE_URL not set'); process.exit(1); }
  // Same as the other sample scripts (08-session-stats.cjs).
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    const cleaned = await clean(c);
    console.log(`[sample-human-time] cleared previous run: ${cleaned.cowork} Cowork, ${cleaned.code} Code sessions`);
    if (!CLEAN_ONLY) {
      const s = await seed(c);
      console.log(`[sample-human-time] seeded ${s.cowork} Cowork and ${s.code} Code Tier 2/3 sessions`);
    }
  } finally {
    await c.end();
  }
})().catch(err => { console.error('[sample-human-time] failed:', err); process.exit(1); });

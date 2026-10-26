#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Second follow-up fix pass. Two real bugs found by reviewing the actual
// rendered "My Pulse" page after 01b-follow-up-2.cjs:
//
//   1. v2's "current week" / "today" raw-row timestamps could land in the
//      FUTURE relative to when the script ran (wStart/dayStart + rand(0, full
//      period) with no cap at `now`), unlike v1 which correctly capped this.
//      A future-dated code_session_classifications row computes a NEGATIVE
//      week index in app/api/pulse/code/me/route.ts's `now - r.last_at`
//      bucketing, so it silently vanishes from the Journey Grid's most-recent
//      week for EVERY user, not just the demo account — this refixes it everywhere.
//   2. Sam Taylor's users.department is blank, so 01-organisation.cjs's
//      `WHERE department IS NOT NULL` filter excluded him from ALL base
//      Work Pulse activity (cowork_user_message + pulse_classifications).
//      OTI/DDS on "My Pulse" read from exactly that data, so they showed
//      "Pending data" — not a display bug, he genuinely had zero rows.
//      Backfills the same 8-completed-week base activity every other user
//      already has. Also re-dates his frontier/milestone events to `now`
//      minus at most a few hours so they reliably outrank the older
//      pre-existing "First unknown task" row the hero was still showing.
//
// Marker `ff3-`. Safe to re-run (clears + reinserts its own rows first).
// Usage: docker compose exec hub node scripts/demo/01c-follow-up-3.cjs [--clean]
const { Client } = require('pg');

const MARKER = 'ff3-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const WEEK = 7 * DAY;
const N_COMPLETED_WEEKS = 8;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

function mondayUtcStart(tsSec) {
  const d = new Date(tsSec * 1000);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
  return Math.floor(monday / 1000);
}

const SAM_ID = 'sam.taylor@example.com';
const SAM_REPO = 'internal-tools'; // matches Enablement in REPO_BY_DEPT elsewhere
const COWORK_PROMPTS_SAM = [
  'Review the latest use-case governance rollup before the board update.',
  'Draft the exec summary for this quarter\'s FinOps review.',
  'Summarise the top risks flagged across departments this week.',
  'Turn these customer call notes into a follow-up brief.',
  'Check the classifier rubric change for unintended drift before it ships.',
];
const TASK_TYPES = ['analysis', 'structured_report', 'synthesis', 'summarisation', 'process_substitution'];
const MODELS_WEIGHTED = [['claude-opus-4-8', 2], ['claude-sonnet-4-6', 6], ['claude-haiku-4-5', 3]];
const weightedModel = () => pick(MODELS_WEIGHTED.flatMap(([m, w]) => Array(w).fill(m)));
const CODE_TASK_TYPES = ['bug_investigation', 'feature_build', 'code_review', 'documentation', 'refactor'];
const RATES = { 'claude-opus-4-8': { in: 5, out: 25 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 } };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run this inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  const now = Math.floor(Date.now() / 1000);
  const currentWeekStart = mondayUtcStart(now);

  try {
    // ── 0. Clear this script's own prior rows ───────────────────────────────
    await c.query(`DELETE FROM code_session_classifications WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_skill_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_mcp_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_otel_metrics WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_session_stats WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_assistant_meta WHERE id LIKE $1`, [`${MARKER}%`]);
    console.log('[fullflow-v3] cleared prior seed rows.');

    if (CLEAN_ONLY) { console.log('[fullflow-v3] --clean complete.'); return; }

    // ── 1. Fix #1: re-run v2's two future-dated loops with a proper `now` cap,
    // scoped to just the current (weeksAgo/daysAgo === 0) period so this is a
    // small top-up, not a full re-seed. Applies to every real department user
    // (the bug hit everyone's most-recent week, not just the demo account's). ────────────
    const usersRes = await c.query(
      `SELECT id, display_name, department FROM users WHERE department IS NOT NULL AND TRIM(department) != ''`);
    const REPO_BY_DEPT = {
      Engineering: 'platform-core', Product: 'platform-core', Enablement: 'internal-tools',
      Finance: 'finance-scripts', HR: 'people-ops-tools', Legal: 'legal-automation',
      Marketing: 'marketing-tools', Sales: 'sales-tools', 'Customer Success': 'cs-tools',
    };
    const CODE_INTENSITY = { Engineering: 'high', Enablement: 'high', Platform: 'high', Data: 'high', AppliedAI: 'high', Product: 'medium' };
    const intensityFor = (dept) => CODE_INTENSITY[dept] || 'low';

    let fixedSessN = 0;
    for (const u of usersRes.rows) {
      const intensity = intensityFor(u.department);
      if (intensity === 'low' && Math.random() < 0.2) continue;
      const repo = REPO_BY_DEPT[u.department] || 'internal-tools';
      // Current week only, capped strictly before `now` (the bug this refixes).
      const ts = currentWeekStart + rand(0, Math.max(1, now - currentWeekStart - 1));
      const tier = rand(2, 3);
      const model = weightedModel();
      const input = rand(3000, 22000), output = rand(400, 3500);
      const sessionId = uid('jsess');
      await c.query(
        `INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, error_count, cwd, git_branch, occurred_at, ingested_at, commit_count, source, query_source)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,'end_turn',$8,0,$9,'main',$10,$10,$11,'otel','main')`,
        [uid('jmeta'), u.id, sessionId, model, input, output, rand(2000, 30000), rand(1, 6), `/repos/${repo}`, ts, tier === 3 ? 1 : 0]);
      await c.query(
        `INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, error_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, models_json, skills_json, mcp_json, commit_count, computed_at)
         VALUES ($1,$2,$3,'main',$4,$4,1,1,$5,0,$6,$7,0,0,$8,'[]','[]',$9,$4)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, u.id, repo, ts, rand(1, 6), input, output, JSON.stringify({ [model]: { input, output, cache_creation: 0, cache_read: 0 } }), tier === 3 ? 1 : 0]);
      await c.query(
        `INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
         VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001','classified',$6)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, u.id, pick(CODE_TASK_TYPES), tier, 0.78 + Math.random() * 0.18, ts]);
      fixedSessN++;
    }
    console.log(`[fullflow-v3] fix #1: added ${fixedSessN} correctly-dated current-week Journey Grid sessions (was landing in the future before).`);

    // ── 2. Fix #2: Sam Taylor's base Work Pulse activity — the same 8-week
    // classified-message backfill everyone else got in 01-organisation.cjs,
    // which his blank department excluded him from. ───────────────────────
    // A fresh installation may have no Sam Taylor account: fixes 2 and 3 run only where it exists.
    const samExists = (await c.query('SELECT 1 FROM users WHERE id = $1', [SAM_ID])).rowCount > 0;
    let samMsgN = 0, samClassN = 0;
    if (samExists) for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 0; weeksAgo--) {
      const wStart = currentWeekStart - weeksAgo * WEEK;
      const wEndExclusive = weeksAgo === 0 ? now : wStart + WEEK;
      if (wEndExclusive <= wStart) continue;
      const trendP = (N_COMPLETED_WEEKS - weeksAgo) / N_COMPLETED_WEEKS;
      const depth = 0.3 + 0.5 * trendP;
      const t3Share = 0.2 + 0.4 * trendP;
      // Sessions (grouped turns), not one session per message — see the
      // matching fix + comment in 01-organisation.cjs.
      const nSessions = weeksAgo === 0 ? rand(1, 2) : rand(1, 3);
      for (let s = 0; s < nSessions; s++) {
        const sessionId = uid('cwsess');
        const sessionStart = wStart + rand(0, Math.max(1, wEndExclusive - wStart - 1));
        const turnsInSession = rand(1, 3);
        for (let i = 0; i < turnsInSession; i++) {
          const ts = sessionStart + i * rand(60, 900);
          const tier = Math.random() < depth ? (Math.random() < t3Share ? 3 : 2) : 1;
          const msgId = uid('cw');
          await c.query(
            `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at, surface, source)
             VALUES ($1,$2,$3,'cowork_user_message','user',$4,$5,$5,'cowork','otel')`,
            [msgId, sessionId, SAM_ID, pick(COWORK_PROMPTS_SAM), ts]);
          samMsgN++;
          await c.query(
            `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
             VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001',$6)`,
            [msgId, SAM_ID, tier, pick(TASK_TYPES), 0.85 + Math.random() * 0.12, ts + 30]);
          samClassN++;
        }
      }
    }
    console.log(`[fullflow-v3] fix #2: ${samExists ? `backfilled the Sam Taylor account's base Work Pulse activity — ${samMsgN} messages, ${samClassN} classifications across 9 weeks` : 'skipped, the Sam Taylor account is not here'}.`);

    // ── 3. Re-date the demo account's frontier/milestone events to comfortably outrank the
    // pre-existing "First unknown task" row the hero was still showing. ────
    if (samExists) {
    const anchorId = uid('anchor');
    const anchorTs = now - rand(0, 3 * 3600); // within the last 3 hours
    await c.query(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, surface, source, occurred_at, ingested_at)
       VALUES ($1,$1,$2,'cowork_user_message','user',$3,'cowork','otel',$4,$4)`,
      [anchorId, SAM_ID, 'Reviewed the governance rollup for a pattern we hadn\'t automated before.', anchorTs]);
    await c.query(
      `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
       VALUES ($1,'frontier_push','confirmed','First governance synthesis task','You ran a governance synthesis task for the first time — a new type of work entering your delegation range.',$2,3,$3)`,
      [SAM_ID, anchorId, anchorTs]);
    await c.query(
      `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
       VALUES ($1,'capability_creation','candidate','New capability — Governance Synthesis','Tier 3 session flagged as a potential new capability. Prompt: "Review the latest use-case governance rollup before the board update."',$2,3,$3)`,
      [SAM_ID, anchorId, anchorTs - 3600]);
    console.log(`[fullflow-v3] fix #3: re-dated the demo account's Frontier Push + added a Capability Creation candidate, both within the last 3 hours.`);
    }

    // ── 4. Reset aggregator cursors ──────────────────────────────────────────
    for (const key of ['pulse_aggregator_last_run', 'pulse_aggregator_daily_last_run', 'code_aggregator_last_run']) {
      await c.query(`INSERT INTO config (key, value) VALUES ($1, '') ON CONFLICT (key) DO UPDATE SET value = ''`, [key]);
    }
    console.log('[fullflow-v3] aggregator cursors reset — rolling snapshots recompute within ~60s.');
    console.log('[fullflow-v3] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

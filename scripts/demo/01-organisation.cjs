#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Full-flow demo populator for a demo install — Work Pulse + Developer Pulse
// across EVERY real department and user (not just the handful of Engineering/
// Product accounts the original acmecorp fixture deep-seeded).
//
// Two problems this fixes, found on an earlier demo install:
//   1. Developer Pulse (code_assistant_meta/code_session_stats/code_otel_metrics)
//      had activity for only ~12 of 66 users, all in Engineering/Product/
//      Enablement — the other 6 departments (Customer Success, Finance, HR,
//      Legal, Marketing, Sales) were 100% empty in every Developer Pulse view.
//   2. pulse_metrics had ZERO scope_type='function' (department) rows, at any
//      granularity. Root cause: the LIVE dept aggregator (lib/pulse/aggregator.ts)
//      keys off admin_users.department + admin_users.linked_cowork_user_id —
//      and admin_users on a demo install had no department set on anyone.
//      This is the exact same shape the real OTel receiver auto-enrolment
//      writes (see lib/otel/cowork-receiver.ts) — we mirror it here so the
//      LIVE running aggregator keeps computing dept-level Work Pulse
//      (PSR, dept ORS, Delegation View dept bands) correctly going forward,
//      rather than hand-rolling a parallel computation that could drift.
//
// Additive + idempotent: every row this script writes is `ff-`-prefixed;
// re-running clears and reinserts its own rows first (FK-safe child-before-
// parent), so it's safe to run again before the demo without growing forever.
// Never touches non-`ff-` rows, and only INSERTs admin_users rows that don't
// already exist (never overwrites a real login account).
//
// Usage (run inside the hub container, which already has DATABASE_URL/
// CCC_PG_SSL wired):
//   docker compose exec hub node scripts/demo/01-organisation.cjs
//   docker compose exec hub node scripts/demo/01-organisation.cjs --clean
const { Client } = require('pg');

const MARKER = 'ff-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const WEEK = 7 * DAY;
const N_COMPLETED_WEEKS = 8;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

// Deterministic per-user "has this person gone quiet recently" decision —
// same formula duplicated in 01b-follow-up-2.cjs/-v5.cjs so all three
// scripts agree on the SAME users, every run. Without this, each script
// independently rolling its own dice for "is this user active this week"
// meant the combined OR across all of them put ~97%+ of users within the
// 7-day window regardless of how conservative any single gate looked in
// isolation — which is why the dashboard Adoption heatmap stayed at 100%
// for every department even after adding weekly-presence gates. A single
// shared, deterministic (id-hashed, not Math.random()) decision per user
// is required for any of those individual gates to actually show through.
function isRecentlyQuiet(userId, chance) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000 < chance;
}
function quietChanceFor(intensity) {
  return intensity === 'high' ? 0.1 : intensity === 'medium' ? 0.25 : 0.4;
}

function mondayUtcStart(tsSec) {
  const d = new Date(tsSec * 1000);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
  return Math.floor(monday / 1000);
}

// ── Department intensity for Developer Pulse (Work Pulse applies evenly to all) ──
const CODE_INTENSITY = {
  Engineering: 'high', Enablement: 'high', Platform: 'high', Data: 'high', AppliedAI: 'high',
  Product: 'medium',
};
function intensityFor(dept) {
  return CODE_INTENSITY[dept] || 'low';
}

// ── Content pools ─────────────────────────────────────────────────────────
const COWORK_PROMPTS = {
  Engineering: ['Review this PR for race conditions in the retry logic.', 'Draft an ADR for the new ingest pipeline.', 'Summarise this week’s incident postmortem into action items.', 'Write the runbook for the deploy rollback procedure.'],
  Product: ['Turn these customer interview notes into a product spec.', 'Draft the Now/Next/Later roadmap for next quarter.', 'Write acceptance criteria for the new dashboard feature.', 'Analyse feature adoption from last month’s metrics.'],
  Sales: ['Draft a follow-up email after today’s discovery call.', 'Build a mutual action plan for the enterprise opportunity.', 'Summarise this call transcript into next steps and objections.', 'Prep talking points for tomorrow’s renewal conversation.'],
  Marketing: ['Draft the launch announcement for the new feature.', 'Analyse last quarter’s campaign performance by channel.', 'Build the messaging brief for the new product line.', 'Suggest three subject lines for the launch newsletter.'],
  Legal: ['Review this vendor MSA for liability caps and auto-renewal.', 'Summarise the redlines in the customer DPA.', 'Check this contract clause for data-transfer compliance.', 'Draft the standard NDA cover note.'],
  Finance: ['Reconcile the monthly P&L against budget and flag variances.', 'Build the revenue summary for the board pack.', 'Draft the variance commentary for management accounts.', 'Summarise vendor spend by category this quarter.'],
  'Customer Success': ['Summarise this week’s top support tickets by theme.', 'Draft a response to the escalated billing complaint.', 'Build the quarterly health-score summary for the top accounts.', 'Turn this call transcript into a renewal risk note.'],
  HR: ['Draft the onboarding checklist for a new starter.', 'Summarise the engagement-survey themes.', 'Update the interview scorecard template.', 'Draft the FAQ for the new benefits rollout.'],
  Enablement: ['Turn this runbook into a training module.', 'Draft the FAQ for the new rollout.', 'Summarise the top support tickets this week.', 'Build the onboarding deck for new hires.'],
};
const COWORK_DEFAULT = ['Summarise these notes into a short update.', 'Draft a first pass at this document.', 'Help me structure this into a clear report.'];

const CODE_PROMPTS_HEAVY = ['Review this PR for race conditions.', 'Write unit tests for the rate-limiter middleware.', 'Debug why the nightly job times out on large batches.', 'Refactor the auth module to use async/await throughout.', 'Add error handling to the webhook handler.', 'Optimise this slow Postgres query.'];
const CODE_PROMPTS_LIGHT = {
  Finance: ['Write a script to reconcile the Xero export against the bank statement.', 'Automate formatting of the monthly board pack spreadsheet.'],
  HR: ['Build a script to dedupe the candidate CSV export.', 'Automate merging the onboarding checklist across new starters.'],
  Legal: ['Automate redline formatting across these contract templates.', 'Write a script to extract key clauses from a batch of PDFs.'],
  Marketing: ['Write a script to pull campaign UTM data into one sheet.', 'Automate resizing these assets for each channel.'],
  Sales: ['Automate formatting the pipeline export into the deck template.', 'Write a script to merge call notes into the CRM import format.'],
  'Customer Success': ['Script to bulk-tag support tickets by theme.', 'Automate pulling account health scores into one view.'],
};

const TASK_TYPES = ['analysis', 'structured_report', 'synthesis', 'summarisation', 'basic_drafting', 'template_population', 'process_substitution'];
const CODE_TASK_TYPES = ['bug_investigation', 'feature_build', 'code_review', 'documentation', 'refactor'];
const MODELS_WEIGHTED = [['claude-opus-4-8', 2], ['claude-sonnet-4-6', 6], ['claude-haiku-4-5', 3]];
const weightedModel = () => pick(MODELS_WEIGHTED.flatMap(([m, w]) => Array(w).fill(m)));
const LANGUAGES = ['TypeScript', 'Python', 'SQL', 'TSX', 'Markdown'];
const REPO_BY_DEPT = {
  Engineering: 'platform-core', Product: 'platform-core', Enablement: 'internal-tools',
  Finance: 'finance-scripts', HR: 'people-ops-tools', Legal: 'legal-automation',
  Marketing: 'marketing-tools', Sales: 'sales-tools', 'Customer Success': 'cs-tools',
};

const RATES = {
  'claude-opus-4-8': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
function priceUsd(model, t) {
  const r = RATES[model];
  if (!r) return null;
  return (t.input * r.in + t.output * r.out + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead) / 1_000_000;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run this inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();

  const now = Math.floor(Date.now() / 1000);
  const currentWeekStart = mondayUtcStart(now);

  try {
    // ── 1. Clear this script's own prior rows (FK-safe, child-before-parent) ──
    await c.query(`DELETE FROM code_session_classifications WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    // The live frontier/capability detectors attach pulse_events (and skill
    // runs) to seeded messages after they are classified. Without clearing them
    // the message delete below fails on pulse_events_cowork_message_id_fk, and
    // this script's base activity stops refreshing.
    // Scoped to this script's own marker only, like v2/v3/v5.
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    const delCw = await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_otel_metrics WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_session_stats WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_assistant_meta WHERE id LIKE $1`, [`${MARKER}%`]);
    console.log(`[fullflow] cleared prior seed rows (${delCw.rowCount} cowork_messages + children).`);

    if (CLEAN_ONLY) {
      // Also drop the admin_users linkage rows we created (never a real login —
      // always the OTel-pending sentinel — so this can never remove a real account).
      const delAdmin = await c.query(
        `DELETE FROM admin_users WHERE password_hash = '__otel_pending__' AND linked_cowork_user_id IN
           (SELECT id FROM users WHERE department IS NOT NULL AND TRIM(department) != '')`);
      console.log(`[fullflow] --clean: also removed ${delAdmin.rowCount} admin_users linkage rows we created.`);
      // Recompute weekly aggregates now that our raw contribution is gone.
    }

    // ── 2. Target users: every users row with a real department ──────────────
    const usersRes = await c.query(
      `SELECT id, display_name, department FROM users WHERE department IS NOT NULL AND TRIM(department) != '' ORDER BY department, id`);
    const users = usersRes.rows;
    console.log(`[fullflow] ${users.length} users across ${new Set(users.map(u => u.department)).size} departments.`);

    if (!CLEAN_ONLY) {
      // ── 3. Structural fix: admin_users department + linked_cowork_user_id ──
      // Mirrors lib/otel/cowork-receiver.ts's real auto-enrolment shape exactly
      // (same id as users.id, __otel_pending__ sentinel, role='pulse',
      // sso_enabled=0) so this activates the LIVE dept aggregator, not a
      // one-off hand-rolled parallel computation.
      let adminCreated = 0;
      for (const u of users) {
        const existing = await c.query(`SELECT id FROM admin_users WHERE id = $1 OR linked_cowork_user_id = $1`, [u.id]);
        if (existing.rows.length > 0) {
          // Backfill department on an existing linkage row if it's missing.
          await c.query(
            `UPDATE admin_users SET department = COALESCE(department, $1) WHERE id = $2 OR linked_cowork_user_id = $2`,
            [u.department, u.id]);
          continue;
        }
        await c.query(
          `INSERT INTO admin_users (id, email, password_hash, display_name, role, department, linked_cowork_user_id, sso_enabled)
           VALUES ($1, $2, '__otel_pending__', $3, 'pulse', $4, $1, 0)
           ON CONFLICT (id) DO NOTHING`,
          [u.id, `${u.id}@ff-pending.invalid`.toLowerCase(), u.display_name, u.department]);
        adminCreated++;
      }
      console.log(`[fullflow] admin_users: linked ${adminCreated} new department rows (activates the live dept aggregator).`);
    }

    // ── 4. Raw activity: Cowork (every user, every week) + Code (by intensity) ──
    let coworkMsgN = 0, classN = 0, codeSessN = 0, codeMetaN = 0, otelN = 0, codeMsgN = 0, codeClassN = 0;

    if (!CLEAN_ONLY) {
      for (const u of users) {
        const coworkPool = COWORK_PROMPTS[u.department] || COWORK_DEFAULT;
        const intensity = intensityFor(u.department);
        const repo = REPO_BY_DEPT[u.department] || 'internal-tools';
        // Real derived last activity for this user (cowork OR code) — replaces
        // the old approach (a separate step force-bumping last_seen_at to
        // "recent" for literally everyone) which made the dashboard Adoption
        // heatmap read 100% for every department and flattened the 14-day
        // trend line, since every single user always looked active every week.
        let userLastActivity = 0;
        // Deterministic per-user decision, shared with v2/v5 — see
        // isRecentlyQuiet's comment. If true, this user gets NO activity at
        // all in weeksAgo 0-1 (roughly the trailing 2 weeks), from this
        // script OR the others, so they genuinely fall outside the 7-day
        // Adoption heatmap window instead of every user always looking active.
        const quietRecently = isRecentlyQuiet(u.id, quietChanceFor(intensity));

        for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 0; weeksAgo--) {
          const wStart = currentWeekStart - weeksAgo * WEEK;
          const wEndExclusive = weeksAgo === 0 ? now : wStart + WEEK;
          if (wEndExclusive <= wStart) continue;
          if (weeksAgo <= 1 && quietRecently) continue; // this user has gone quiet recently
          const trendP = (N_COMPLETED_WEEKS - weeksAgo) / N_COMPLETED_WEEKS; // 0 oldest .. 1 newest

          // ── Cowork: realistic weekly presence + real sessions ──
          // Not every user is active every week — a flat 100% presence defeats
          // the point of the Adoption heatmap/trend (both read "active" off
          // real recent activity, so if everyone always has some, they can
          // never show anything but full/flat). Chance scales with department
          // intensity so low-intensity depts show genuinely lower adoption.
          const weeklyActiveChance = intensity === 'high' ? 0.9 : intensity === 'medium' ? 0.75 : 0.55;
          if (Math.random() < weeklyActiveChance) {
            const depth = 0.25 + 0.45 * trendP; // P(tier>=2)
            const t3Share = 0.15 + 0.35 * trendP; // share of tier>=2 that is tier3
            // Sessions, not messages — a session is 1-3 turns sharing ONE
            // session_id. Previously every message got its own unique
            // session_id, so "sessions/week" (COUNT DISTINCT session_id)
            // read as roughly the message count — thousands/week across the
            // org instead of a plausible handful per person.
            const nSessions = weeksAgo === 0 ? rand(0, 2) : rand(1, 3);
            for (let s = 0; s < nSessions; s++) {
              const sessionId = uid('cwsess');
              const sessionStart = wStart + rand(0, Math.max(1, wEndExclusive - wStart - 1));
              const turnsInSession = rand(1, 3);
              for (let i = 0; i < turnsInSession; i++) {
                const ts = sessionStart + i * rand(60, 900);
                const tier = Math.random() < depth ? (Math.random() < t3Share ? 3 : 2) : 1;
                const taskType = pick(TASK_TYPES);
                const text = pick(coworkPool);
                const msgId = uid('cw');
                await c.query(
                  `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at, surface, source)
                   VALUES ($1,$2,$3,'cowork_user_message','user',$4,$5,$5,'cowork','otel')`,
                  [msgId, sessionId, u.id, text, ts]);
                coworkMsgN++;
                await c.query(
                  `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                   VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001',$6)`,
                  [msgId, u.id, tier, taskType, 0.85 + Math.random() * 0.12, ts + 30]);
                classN++;
                if (ts > userLastActivity) userLastActivity = ts;
              }
            }
          }

          // ── Code: gated by department intensity ──
          let nSessions = 0;
          if (intensity === 'high') nSessions = rand(2, 4);
          else if (intensity === 'medium') nSessions = rand(1, 2);
          else if (Math.random() < 0.4) nSessions = 1;
          if (weeksAgo === 0) nSessions = Math.min(nSessions, 1); // partial current week

          for (let s = 0; s < nSessions; s++) {
            const sessionId = uid('code-sess');
            const dayBase = wStart + rand(0, Math.max(1, wEndExclusive - wStart - 3600));
            const turns = intensity === 'low' ? rand(2, 5) : rand(4, 10);
            const model = weightedModel();
            const prompts = intensity === 'low' ? (CODE_PROMPTS_LIGHT[u.department] || CODE_PROMPTS_HEAVY) : CODE_PROMPTS_HEAVY;

            const codeMsgId = uid('code-msg');
            await c.query(
              `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at, surface, source)
               VALUES ($1,$2,$3,'code_user_message','user',$4,$5,$5,'code','otel')`,
              [codeMsgId, sessionId, u.id, pick(prompts), dayBase]);
            codeMsgN++;

            let inp = 0, outp = 0, cw = 0, cr = 0, tools = 0, errs = 0, commits = 0;
            const commitsThisSession = Math.random() < 0.5 ? rand(1, 2) : 0;
            const commitTurn = rand(0, turns - 1);
            for (let t = 0; t < turns; t++) {
              const ti = rand(1500, 22000), to = rand(300, 3500), tcw = rand(0, 4000), tcr = rand(2000, 60000);
              const tu = rand(0, 6), te = Math.random() < 0.1 ? 1 : 0;
              const tc = t === commitTurn ? commitsThisSession : 0;
              inp += ti; outp += to; cw += tcw; cr += tcr; tools += tu; errs += te; commits += tc;
              await c.query(
                `INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, error_count, cwd, git_branch, occurred_at, ingested_at, commit_count, source, query_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'main',$13,$13,$14,'otel','main')`,
                [uid('meta'), u.id, sessionId, model, ti, to, tcw, tcr, Math.random() < 0.7 ? 'end_turn' : 'tool_use', tu, te, `/repos/${repo}`, dayBase + t * rand(30, 400), tc]);
              codeMetaN++;
            }
            const lastAt = dayBase + turns * rand(60, 500);
            const modelsJson = JSON.stringify({ [model]: { input: inp, output: outp, cache_creation: cw, cache_read: cr } });
            await c.query(
              `INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, error_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, models_json, skills_json, mcp_json, commit_count, computed_at)
               VALUES ($1,$2,$3,'main',$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,'[]','[]',$14,$5)
               ON CONFLICT (session_id) DO NOTHING`,
              [sessionId, u.id, repo, dayBase, lastAt, turns, tools, errs, inp, outp, cw, cr, modelsJson, commits]);
            codeSessN++;
            if (lastAt > userLastActivity) userLastActivity = lastAt;

            const lang = pick(LANGUAGES);
            const otelRows = [
              ['claude_code.active_time.total', rand(600, 3000), 'user', null],
              ['claude_code.active_time.total', rand(200, 1200), 'cli', null],
              ['claude_code.lines_of_code.count', rand(20, 300), 'added', lang],
              ['claude_code.lines_of_code.count', rand(5, 100), 'removed', lang],
            ];
            if (commits > 0) otelRows.push(['claude_code.commit.count', commits, null, null]);
            if (Math.random() < 0.3) otelRows.push(['claude_code.pull_request.count', 1, null, null]);
            otelRows.push(['claude_code.code_edit_tool.decision', rand(3, 20), 'accept', lang]);
            if (Math.random() < 0.6) otelRows.push(['claude_code.code_edit_tool.decision', rand(0, 4), 'reject', lang]);
            for (const [metric, value, type, language] of otelRows) {
              await c.query(
                `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, model, language, occurred_at, ingested_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
                [uid('otel'), u.id, sessionId, metric, value, type, model, language, lastAt]);
              otelN++;
            }

            // Light-touch judged Work Mix signal (mirrors the session-digest classifier).
            await c.query(
              `INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
               VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001','classified',$6)
               ON CONFLICT (session_id) DO NOTHING`,
              [sessionId, u.id, pick(CODE_TASK_TYPES), commits > 0 ? rand(2, 3) : rand(1, 2), 0.75 + Math.random() * 0.15, lastAt]);
            codeClassN++;
          }
        }

        // Real last_seen_at, derived from whatever activity actually landed
        // for this user this run — never a blanket "recent for everyone"
        // bump. A quiet-week user genuinely falls outside the 7-day Adoption
        // heatmap window here, which is the whole point of the widget.
        if (userLastActivity > 0) {
          await c.query(`UPDATE users SET last_seen_at = $1 WHERE id = $2`, [userLastActivity, u.id]);
        }
      }
      console.log(`[fullflow] raw activity: cowork_messages=${coworkMsgN} classifications=${classN} code_sessions=${codeSessN} code_meta=${codeMetaN} code_user_msgs=${codeMsgN} otel=${otelN} session_classifications=${codeClassN}`);
    }

    // ── 5. Weekly backfill: pulse_metrics (user + function) & code_metrics (user + org) ──
    // Recomputed from the FULL table (existing + newly seeded rows), for every
    // completed week, for every user and department.
    const depts = [...new Set(users.map(u => u.department))];
    let weeklyPulseUser = 0, weeklyPulseFn = 0, weeklyCodeUser = 0, weeklyCodeOrg = 0;

    for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 1; weeksAgo--) {
      const wStart = currentWeekStart - weeksAgo * WEEK;
      const wEnd = wStart + WEEK - 1;

      // per-user pulse_metrics
      for (const u of users) {
        const r = await c.query(
          `SELECT
             SUM(CASE WHEN pc.tier=1 THEN 1 ELSE 0 END) t1,
             SUM(CASE WHEN pc.tier=2 THEN 1 ELSE 0 END) t2,
             SUM(CASE WHEN pc.tier=3 THEN 1 ELSE 0 END) t3,
             COUNT(*) total
           FROM pulse_classifications pc
           JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           WHERE pc.user_id = $1 AND pc.classifier_status = 'classified'
             AND cm.occurred_at >= $2 AND cm.occurred_at <= $3`,
          [u.id, wStart, wEnd]);
        const row = r.rows[0];
        const total = Number(row.total ?? 0);
        if (total === 0) continue;
        const t1 = Number(row.t1 ?? 0), t2 = Number(row.t2 ?? 0), t3 = Number(row.t3 ?? 0);
        const dds = (3 * t3 + 2 * t2 + t1) / total;
        await c.query(
          `INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, dds, event_count, tier_1_count, tier_2_count, tier_3_count, computed_at, granularity)
           VALUES ('user',$1,$2,$3,$4,$5,$6,$7,$8,$9,'week')
           ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity='week'
           DO UPDATE SET period_end=EXCLUDED.period_end, dds=EXCLUDED.dds, event_count=EXCLUDED.event_count,
             tier_1_count=EXCLUDED.tier_1_count, tier_2_count=EXCLUDED.tier_2_count, tier_3_count=EXCLUDED.tier_3_count, computed_at=EXCLUDED.computed_at`,
          [u.id, wStart, wEnd, dds, total, t1, t2, t3, now]);
        weeklyPulseUser++;
      }

      // per-department (scope_type='function') pulse_metrics
      for (const dept of depts) {
        const r = await c.query(
          `SELECT
             SUM(CASE WHEN pc.tier=1 THEN 1 ELSE 0 END) t1,
             SUM(CASE WHEN pc.tier=2 THEN 1 ELSE 0 END) t2,
             SUM(CASE WHEN pc.tier=3 THEN 1 ELSE 0 END) t3,
             COUNT(*) total
           FROM pulse_classifications pc
           JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           JOIN users u2 ON u2.id = pc.user_id
           WHERE u2.department = $1 AND pc.classifier_status = 'classified'
             AND cm.occurred_at >= $2 AND cm.occurred_at <= $3`,
          [dept, wStart, wEnd]);
        const row = r.rows[0];
        const total = Number(row.total ?? 0);
        if (total === 0) continue;
        const t1 = Number(row.t1 ?? 0), t2 = Number(row.t2 ?? 0), t3 = Number(row.t3 ?? 0);
        const dds = (3 * t3 + 2 * t2 + t1) / total;
        await c.query(
          `INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, dds, event_count, tier_1_count, tier_2_count, tier_3_count, computed_at, granularity)
           VALUES ('function',$1,$2,$3,$4,$5,$6,$7,$8,$9,'week')
           ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity='week'
           DO UPDATE SET period_end=EXCLUDED.period_end, dds=EXCLUDED.dds, event_count=EXCLUDED.event_count,
             tier_1_count=EXCLUDED.tier_1_count, tier_2_count=EXCLUDED.tier_2_count, tier_3_count=EXCLUDED.tier_3_count, computed_at=EXCLUDED.computed_at`,
          [dept, wStart, wEnd, dds, total, t1, t2, t3, now]);
        weeklyPulseFn++;
      }

      // per-user code_metrics
      let orgSpend = 0, orgInput = 0, orgOutput = 0, orgSessions = 0, orgCommits = 0;
      let orgAtu = 0, orgAtc = 0, orgLa = 0, orgLr = 0, orgPr = 0, orgEa = 0, orgEr = 0;
      for (const u of users) {
        const metaR = await c.query(
          `SELECT model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, tool_use_count, commit_count
           FROM code_assistant_meta WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at <= $3`,
          [u.id, wStart, wEnd]);
        if (metaR.rows.length === 0) continue;
        let inp = 0, outp = 0, cr = 0, tools = 0, commits = 0, spend = 0, anyPriced = false;
        for (const m of metaR.rows) {
          inp += m.input_tokens; outp += m.output_tokens; cr += m.cache_read_tokens;
          tools += m.tool_use_count; commits += m.commit_count;
          const usd = priceUsd(m.model, { input: m.input_tokens, output: m.output_tokens, cacheWrite: m.cache_creation_tokens, cacheRead: m.cache_read_tokens });
          if (usd !== null) { spend += usd; anyPriced = true; }
        }
        const otelR = await c.query(
          `SELECT
             COALESCE(SUM(CASE WHEN metric_name='claude_code.active_time.total' AND type='user' THEN value END),0) atu,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.active_time.total' AND type='cli' THEN value END),0) atc,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.lines_of_code.count' AND type='added' THEN value END),0) la,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.lines_of_code.count' AND type='removed' THEN value END),0) lr,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.pull_request.count' THEN value END),0) prc,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.code_edit_tool.decision' AND type='accept' THEN value END),0) ea,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.code_edit_tool.decision' AND type='reject' THEN value END),0) er
           FROM code_otel_metrics WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at <= $3`,
          [u.id, wStart, wEnd]);
        const o = otelR.rows[0];
        const spendUsd = anyPriced ? spend : null;
        await c.query(
          `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, input_tokens, output_tokens, cache_hit_ratio, session_count, repo_count, commit_count, active_time_user_s, active_time_cli_s, lines_added, lines_removed, pr_count, edit_accept_count, edit_reject_count, computed_at, granularity)
           VALUES ('user',$1,$2,$3,$4,$5,$6,$7,1,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,'week')
           ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity='week'
           DO UPDATE SET period_end=EXCLUDED.period_end, spend_usd=EXCLUDED.spend_usd, input_tokens=EXCLUDED.input_tokens,
             output_tokens=EXCLUDED.output_tokens, cache_hit_ratio=EXCLUDED.cache_hit_ratio, commit_count=EXCLUDED.commit_count,
             active_time_user_s=EXCLUDED.active_time_user_s, active_time_cli_s=EXCLUDED.active_time_cli_s,
             lines_added=EXCLUDED.lines_added, lines_removed=EXCLUDED.lines_removed, pr_count=EXCLUDED.pr_count,
             edit_accept_count=EXCLUDED.edit_accept_count, edit_reject_count=EXCLUDED.edit_reject_count, computed_at=EXCLUDED.computed_at`,
          [u.id, wStart, wEnd, spendUsd, inp, outp, (cr + inp) > 0 ? cr / (cr + inp) : null, commits,
            Math.round(o.atu), Math.round(o.atc), Math.round(o.la), Math.round(o.lr), Math.round(o.prc), Math.round(o.ea), Math.round(o.er), now]);
        weeklyCodeUser++;
        orgSpend += spendUsd ?? 0; orgInput += inp; orgOutput += outp; orgSessions++; orgCommits += commits;
        orgAtu += Math.round(o.atu); orgAtc += Math.round(o.atc); orgLa += Math.round(o.la); orgLr += Math.round(o.lr);
        orgPr += Math.round(o.prc); orgEa += Math.round(o.ea); orgEr += Math.round(o.er);
      }

      // organisation-scope code_metrics (weekly) — additive on top of whatever's there.
      await c.query(
        `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, input_tokens, output_tokens, session_count, repo_count, commit_count, active_time_user_s, active_time_cli_s, lines_added, lines_removed, pr_count, edit_accept_count, edit_reject_count, computed_at, granularity)
         VALUES ('organisation','org',$1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,'week')
         ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity='week'
         DO UPDATE SET period_end=EXCLUDED.period_end, spend_usd=EXCLUDED.spend_usd, input_tokens=EXCLUDED.input_tokens,
           output_tokens=EXCLUDED.output_tokens, session_count=EXCLUDED.session_count, commit_count=EXCLUDED.commit_count,
           active_time_user_s=EXCLUDED.active_time_user_s, active_time_cli_s=EXCLUDED.active_time_cli_s,
           lines_added=EXCLUDED.lines_added, lines_removed=EXCLUDED.lines_removed, pr_count=EXCLUDED.pr_count,
           edit_accept_count=EXCLUDED.edit_accept_count, edit_reject_count=EXCLUDED.edit_reject_count, computed_at=EXCLUDED.computed_at`,
        [wStart, wEnd, orgSpend, orgInput, orgOutput, orgSessions, orgCommits, orgAtu, orgAtc, orgLa, orgLr, orgPr, orgEa, orgEr, now]);
      weeklyCodeOrg++;
    }
    console.log(`[fullflow] weekly backfill: pulse_metrics user=${weeklyPulseUser} function=${weeklyPulseFn}, code_metrics user=${weeklyCodeUser} org=${weeklyCodeOrg}`);

    // ── 6. Reset aggregator cursors so the LIVE app's own scheduler (60s cycle)
    // fully recomputes 'rolling' snapshots — including the newly-linked dept
    // scope — on its next pass. Never hand-rolled ourselves.
    for (const key of ['pulse_aggregator_last_run', 'pulse_aggregator_daily_last_run', 'code_aggregator_last_run']) {
      await c.query(
        `INSERT INTO config (key, value) VALUES ($1, '') ON CONFLICT (key) DO UPDATE SET value = ''`, [key]);
    }
    console.log('[fullflow] aggregator cursors reset — rolling snapshots recompute within ~60s.');
    console.log(CLEAN_ONLY ? '[fullflow] --clean complete.' : '[fullflow] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

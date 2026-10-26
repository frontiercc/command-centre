#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Gives every admin account the same working My Pulse and My Developer Pulse
// pages as the people in the fictional Acme Corp organisation. Admin accounts
// have no activity of their own until Claude is connected, so without this
// your own pages would be empty.
//
// For each: creates a users row (id = email, department assigned round-robin
// across the 9 existing departments so they blend into the org + benefit from
// any future re-run of 01-organisation.cjs), links admin_users to it (same
// shape the real OTel auto-enrolment writes), then gives them the full
// treatment — 9-week Work Pulse base, 9-week Developer Pulse base + weekly
// code_metrics backfill, a recent Frontier Push + Capability Creation
// candidate, and skills/connectors in the last 7 days.
//
// Marker `ff5-`. Re-running clears + reinserts this script's own rows first;
// never touches anything unprefixed.
// Usage: docker compose exec hub node scripts/demo/02-your-account.cjs [--clean]
const { Client } = require('pg');

const MARKER = 'ff5-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const WEEK = 7 * DAY;
const N_COMPLETED_WEEKS = 8;
const DEPARTMENTS = ['Customer Success', 'Enablement', 'Engineering', 'Finance', 'HR', 'Legal', 'Marketing', 'Product', 'Sales'];
const CODE_INTENSITY = { Engineering: 'high', Enablement: 'high' };
const intensityFor = (dept) => CODE_INTENSITY[dept] || (Math.random() < 0.4 ? 'medium' : 'low');
const REPO_BY_DEPT = {
  Engineering: 'platform-core', Product: 'platform-core', Enablement: 'internal-tools',
  Finance: 'finance-scripts', HR: 'people-ops-tools', Legal: 'legal-automation',
  Marketing: 'marketing-tools', Sales: 'sales-tools', 'Customer Success': 'cs-tools',
};

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

// Deterministic per-user "gone quiet recently" decision — MUST match
// 01-organisation.cjs/-v2.cjs exactly. See that file's comment on this
// function for why independent per-script Math.random() gates don't work.
function isRecentlyQuiet(userId, chance) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000 < chance;
}
function quietChanceFor(intensity) {
  return intensity === 'high' ? 0.1 : intensity === 'medium' ? 0.25 : 0.4;
}

const MODELS_WEIGHTED = [['claude-opus-4-8', 2], ['claude-sonnet-4-6', 6], ['claude-haiku-4-5', 3]];
const weightedModel = () => pick(MODELS_WEIGHTED.flatMap(([m, w]) => Array(w).fill(m)));
const RATES = { 'claude-opus-4-8': { in: 5, out: 25 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 } };
const LANGUAGES = ['TypeScript', 'Python', 'SQL', 'Markdown'];
const CODE_TASK_TYPES = ['bug_investigation', 'feature_build', 'code_review', 'documentation', 'refactor'];
const COWORK_TASK_TYPES = ['analysis', 'structured_report', 'synthesis', 'summarisation', 'process_substitution'];
const SKILLS = ['code-review', 'writing-plans', 'systematic-debugging', 'doc-coauthoring', 'meeting-notes'];
const MCP_SERVERS = [['github', 'search_repos'], ['slack', 'post_message'], ['linear', 'list_issues']];
const FRONTIER_TASK_TYPES = [
  'org_wide_spend_reconciliation', 'cross_department_risk_review', 'demo_environment_health_check',
  'partner_enablement_playbook', 'customer_success_escalation_triage', 'roadmap_dependency_mapping',
  'security_posture_review', 'onboarding_automation_audit', 'pricing_experiment_analysis',
  'exec_briefing_synthesis', 'incident_timeline_reconstruction', 'contract_renewal_risk_scan',
];
const COWORK_PROMPTS = [
  'Check the demo environment health before the customer call.', 'Draft the exec briefing for this week\'s pipeline review.',
  'Review the latest risk register update across departments.', 'Summarise the partner enablement feedback from this month.',
  'Pull together the security posture summary for the customer questionnaire.',
];
// Varied phrasing for each admin's frontier-push anchor message — a single
// hardcoded string here was flagged as repeated verbatim across all 42
// teammates, so every anchor now gets a different, task-specific line.
const ANCHOR_TEMPLATES = [
  (label) => `First real attempt at ${label} — no template to follow yet.`,
  (label) => `Tried ${label} for the first time this week.`,
  (label) => `Took a first pass at ${label} ahead of the review.`,
  (label) => `Worked through ${label} end to end without a playbook.`,
  (label) => `Stepped outside the usual routine to handle ${label}.`,
  (label) => `Explored ${label} while prepping for the exec update.`,
  (label) => `Kicked off ${label} — new territory this quarter.`,
  (label) => `Ran ${label} solo for the first time, no prior example to copy.`,
  (label) => `Gave ${label} a proper first attempt instead of punting it.`,
  (label) => `Handled ${label} directly rather than routing it elsewhere.`,
];

function mondayUtcStart(tsSec) {
  const d = new Date(tsSec * 1000);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff) / 1000);
}
function displayNameFromEmail(email) {
  const local = email.split('@')[0];
  return local.split(/[._]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run inside the hub container.'); process.exit(1); }
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
    console.log('[fullflow-v5] cleared prior seed rows.');

    if (CLEAN_ONLY) {
      console.log('[fullflow-v5] --clean complete (users/admin_users linkage rows created for teammates are left in place — ask explicitly if those should be removed too).');
      return;
    }

    // ── 1. Every admin login except the demo hub's own account ────────────
    const admins = (await c.query(
      `SELECT email, linked_cowork_user_id FROM admin_users WHERE password_hash != '__otel_pending__' AND email != 'sam.taylor@example.com'`
    )).rows;
    console.log(`[fullflow-v5] ${admins.length} teammate admin accounts to provision.`);

    let provisioned = 0, weeklyN = 0, msgN = 0, classN = 0, codeSessN = 0, eventN = 0, skillN = 0, mcpN = 0;
    for (let idx = 0; idx < admins.length; idx++) {
      const admin = admins[idx];
      const userId = admin.email; // same convention as sam.taylor@example.com
      const dept = DEPARTMENTS[idx % DEPARTMENTS.length];
      const displayName = displayNameFromEmail(admin.email);
      const repo = REPO_BY_DEPT[dept];
      const intensity = intensityFor(dept);

      // Create the users row (idempotent) + link admin_users to it (same
      // shape the real OTel auto-enrolment writes). last_seen_at starts at
      // first_seen_at (an honest "no activity yet" placeholder) — it gets
      // set for real below, from whatever activity actually lands, never a
      // blanket "recent" value (that's what made the Adoption heatmap read
      // 100% for every department).
      await c.query(
        `INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,'agent',$5,$5)
         ON CONFLICT (id) DO UPDATE SET department = COALESCE(users.department, EXCLUDED.department)`,
        [userId, admin.email, displayName, dept, now - N_COMPLETED_WEEKS * WEEK]);
      await c.query(
        `UPDATE admin_users SET linked_cowork_user_id = $1, department = COALESCE(department, $2) WHERE email = $3`,
        [userId, dept, admin.email]);

      let adminLastActivity = 0;
      // Same deterministic decision as 01-organisation.cjs/-v2.cjs — if this
      // admin is "gone quiet recently", weeksAgo 0-1 get skipped here too.
      const quietRecently = isRecentlyQuiet(userId, quietChanceFor(intensity));

      // ── Base Work Pulse activity, 9 weeks — realistic weekly presence
      // + real sessions (grouped turns), matching the fix in 01-organisation.cjs. ──
      for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 0; weeksAgo--) {
        const wStart = currentWeekStart - weeksAgo * WEEK;
        const wEndExclusive = weeksAgo === 0 ? now : wStart + WEEK;
        if (wEndExclusive <= wStart) continue;
        if (weeksAgo <= 1 && quietRecently) continue;
        const weeklyActiveChance = intensity === 'high' ? 0.9 : intensity === 'medium' ? 0.75 : 0.55;
        if (Math.random() > weeklyActiveChance) continue;
        const trendP = (N_COMPLETED_WEEKS - weeksAgo) / N_COMPLETED_WEEKS;
        const depth = 0.3 + 0.45 * trendP;
        const t3Share = 0.2 + 0.35 * trendP;
        const nSessions = weeksAgo === 0 ? rand(0, 2) : rand(1, 3);
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
              [msgId, sessionId, userId, pick(COWORK_PROMPTS), ts]);
            msgN++;
            await c.query(
              `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
               VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001',$6)`,
              [msgId, userId, tier, pick(COWORK_TASK_TYPES), 0.85 + Math.random() * 0.12, ts + 30]);
            classN++;
            if (ts > adminLastActivity) adminLastActivity = ts;
          }
        }
      }

      // ── Base Developer Pulse activity, 9 weeks (gated by intensity) ──
      for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 0; weeksAgo--) {
        const wStart = currentWeekStart - weeksAgo * WEEK;
        const wEndExclusive = weeksAgo === 0 ? now : wStart + WEEK;
        if (wEndExclusive <= wStart) continue;
        if (weeksAgo <= 1 && quietRecently) continue;
        const trendP = (N_COMPLETED_WEEKS - weeksAgo) / N_COMPLETED_WEEKS;
        let nSessions = intensity === 'high' ? rand(2, 4) : intensity === 'medium' ? rand(1, 3) : rand(0, 2);
        if (weeksAgo === 0) nSessions = Math.min(nSessions, 2);

        for (let s = 0; s < nSessions; s++) {
          const startAt = wStart + rand(0, Math.max(1, wEndExclusive - wStart - 3600));
          const turns = rand(3, 9);
          const model = weightedModel();
          const sessionId = uid('sess');
          const codeMsgId = uid('cmsg');
          await c.query(
            `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at, surface, source)
             VALUES ($1,$2,$3,'code_user_message','user',$4,$5,$5,'code','otel')`,
            [codeMsgId, sessionId, userId, pick(COWORK_PROMPTS), startAt]);

          let inp = 0, outp = 0, cw = 0, cr = 0, tools = 0, errs = 0, commits = 0;
          const commitsThisSession = Math.random() < 0.5 ? rand(1, 2) : 0;
          const commitTurn = rand(0, turns - 1);
          for (let t = 0; t < turns; t++) {
            const ti = rand(2000, 20000), to = rand(300, 3200), tcw = rand(0, 3500), tcr = rand(2000, 55000);
            const tu = rand(1, 6), te = Math.random() < 0.1 ? 1 : 0;
            const tc = t === commitTurn ? commitsThisSession : 0;
            inp += ti; outp += to; cw += tcw; cr += tcr; tools += tu; errs += te; commits += tc;
            await c.query(
              `INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, error_count, cwd, git_branch, occurred_at, ingested_at, commit_count, source, query_source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'main',$13,$13,$14,'otel','main')`,
              [uid('meta'), userId, sessionId, model, ti, to, tcw, tcr, Math.random() < 0.7 ? 'end_turn' : 'tool_use', tu, te, `/repos/${repo}`, startAt + t * rand(30, 400), tc]);
          }
          const lastAt = startAt + turns * rand(60, 500);
          const modelsJson = JSON.stringify({ [model]: { input: inp, output: outp, cache_creation: cw, cache_read: cr } });
          await c.query(
            `INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, error_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, models_json, skills_json, mcp_json, commit_count, computed_at)
             VALUES ($1,$2,$3,'main',$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,'[]','[]',$14,$5)
             ON CONFLICT (session_id) DO NOTHING`,
            [sessionId, userId, repo, startAt, lastAt, turns, tools, errs, inp, outp, cw, cr, modelsJson, commits]);
          codeSessN++;
          if (lastAt > adminLastActivity) adminLastActivity = lastAt;

          const lang = pick(LANGUAGES);
          const otelRows = [
            ['claude_code.active_time.total', rand(700, 3000), 'user', null],
            ['claude_code.active_time.total', rand(200, 1200), 'cli', null],
            ['claude_code.lines_of_code.count', rand(25, 300), 'added', lang],
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
              [uid('otel'), userId, sessionId, metric, value, type, model, language, lastAt]);
          }
          const tier = Math.random() < 0.3 + 0.4 * trendP ? (Math.random() < 0.25 + 0.35 * trendP ? 3 : 2) : 1;
          await c.query(
            `INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
             VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001','classified',$6)
             ON CONFLICT (session_id) DO NOTHING`,
            [sessionId, userId, pick(CODE_TASK_TYPES), tier, 0.78 + Math.random() * 0.18, lastAt]);
        }
      }

      // ── Weekly code_metrics backfill, 8 completed weeks ──
      for (let weeksAgo = N_COMPLETED_WEEKS; weeksAgo >= 1; weeksAgo--) {
        const wStart = currentWeekStart - weeksAgo * WEEK;
        const wEnd = wStart + WEEK - 1;
        const metaRows = (await c.query(
          `SELECT model, input_tokens, output_tokens, cache_read_tokens, tool_use_count, commit_count
           FROM code_assistant_meta WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at <= $3`,
          [userId, wStart, wEnd])).rows;
        if (metaRows.length === 0) continue;
        let inp = 0, outp = 0, cr = 0, tools = 0, commits = 0, spend = 0, anyPriced = false;
        for (const m of metaRows) {
          inp += m.input_tokens; outp += m.output_tokens; cr += m.cache_read_tokens;
          tools += m.tool_use_count; commits += m.commit_count;
          const r = RATES[m.model];
          if (r) { spend += (m.input_tokens * r.in + m.output_tokens * r.out) / 1_000_000; anyPriced = true; }
        }
        const sessRows = (await c.query(
          `SELECT COUNT(*) n, COALESCE(SUM(user_msg_count),0) msgs FROM code_session_stats WHERE user_id=$1 AND last_at >= $2 AND last_at <= $3`,
          [userId, wStart, wEnd])).rows[0];
        const otelR = (await c.query(
          `SELECT
             COALESCE(SUM(CASE WHEN metric_name='claude_code.active_time.total' AND type='user' THEN value END),0) atu,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.active_time.total' AND type='cli' THEN value END),0) atc,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.lines_of_code.count' AND type='added' THEN value END),0) la,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.lines_of_code.count' AND type='removed' THEN value END),0) lr,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.pull_request.count' THEN value END),0) prc,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.code_edit_tool.decision' AND type='accept' THEN value END),0) ea,
             COALESCE(SUM(CASE WHEN metric_name='claude_code.code_edit_tool.decision' AND type='reject' THEN value END),0) er
           FROM code_otel_metrics WHERE user_id=$1 AND occurred_at >= $2 AND occurred_at <= $3`,
          [userId, wStart, wEnd])).rows[0];
        const msgs = Number(sessRows.msgs);
        await c.query(
          `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, input_tokens, output_tokens, cache_hit_ratio, autonomy_ratio, session_count, repo_count, commit_count, active_time_user_s, active_time_cli_s, lines_added, lines_removed, pr_count, edit_accept_count, edit_reject_count, computed_at, granularity)
           VALUES ('user',$1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,$18,'week')
           ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity='week'
           DO UPDATE SET period_end=EXCLUDED.period_end, spend_usd=EXCLUDED.spend_usd, input_tokens=EXCLUDED.input_tokens,
             output_tokens=EXCLUDED.output_tokens, cache_hit_ratio=EXCLUDED.cache_hit_ratio, autonomy_ratio=EXCLUDED.autonomy_ratio,
             session_count=EXCLUDED.session_count, commit_count=EXCLUDED.commit_count, active_time_user_s=EXCLUDED.active_time_user_s,
             active_time_cli_s=EXCLUDED.active_time_cli_s, lines_added=EXCLUDED.lines_added, lines_removed=EXCLUDED.lines_removed,
             pr_count=EXCLUDED.pr_count, edit_accept_count=EXCLUDED.edit_accept_count, edit_reject_count=EXCLUDED.edit_reject_count, computed_at=EXCLUDED.computed_at`,
          [userId, wStart, wEnd, anyPriced ? spend : null, inp, outp, (cr + inp) > 0 ? cr / (cr + inp) : null,
            msgs > 0 ? tools / msgs : null, Number(sessRows.n), commits,
            Math.round(Number(otelR.atu)), Math.round(Number(otelR.atc)), Math.round(Number(otelR.la)), Math.round(Number(otelR.lr)),
            Math.round(Number(otelR.prc)), Math.round(Number(otelR.ea)), Math.round(Number(otelR.er)), now]);
        weeklyN++;
      }

      // ── Frontier Push + Capability Creation + skills/connectors, recent ──
      const anchorId = uid('anchor');
      const anchorTs = now - rand(0, 4 * 3600);
      const taskSlug = FRONTIER_TASK_TYPES[idx % FRONTIER_TASK_TYPES.length];
      const taskLabel = taskSlug.replace(/_/g, ' ');
      const article = /^[aeiou]/i.test(taskLabel) ? 'an' : 'a';
      const anchorText = pick(ANCHOR_TEMPLATES)(taskLabel);
      await c.query(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, surface, source, occurred_at, ingested_at)
         VALUES ($1,$1,$2,'cowork_user_message','user',$3,'cowork','otel',$4,$4)`,
        [anchorId, userId, anchorText, anchorTs]);
      await c.query(
        `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
         VALUES ($1,'frontier_push','confirmed',$2,$3,$4,$5,$6)`,
        [userId, `First ${taskLabel} task`, `You ran ${article} ${taskLabel} for the first time — a new type of work entering your delegation range.`, anchorId, rand(2, 3), anchorTs]);
      eventN++;
      await c.query(
        `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
         VALUES ($1,'capability_creation','candidate',$2,$3,$4,3,$5)`,
        [userId, `New capability — ${taskLabel.replace(/\b\w/g, ch => ch.toUpperCase())}`, `Tier 3 session flagged as a potential new capability. Prompt: "${pick(COWORK_PROMPTS)}"`, anchorId, anchorTs - 1800]);
      eventN++;
      for (let i = 0; i < rand(1, 3); i++) {
        await c.query(
          `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, invocation_type, surface, source)
           VALUES ($1,$2,$3,$4,$5,$6,'cowork','otel')`,
          [uid('skill'), userId, anchorId, pick(SKILLS), now - rand(0, 6 * DAY), Math.random() < 0.5 ? 'agent_chained' : 'user_typed']);
        skillN++;
      }
      for (let i = 0; i < rand(1, 2); i++) {
        const [server, tool] = pick(MCP_SERVERS);
        await c.query(
          `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, surface, source)
           VALUES ($1,$2,$3,$4,$5,$6,'cowork','otel')`,
          [uid('mcp'), userId, anchorId, server, tool, now - rand(0, 6 * DAY)]);
        mcpN++;
      }

      // Real last_seen_at, derived from whatever activity actually landed
      // for this admin this run (never a blanket recent bump).
      if (adminLastActivity > 0) {
        await c.query(
          `UPDATE users SET last_seen_at = $1 WHERE id = $2 AND (last_seen_at IS NULL OR last_seen_at < $1)`,
          [adminLastActivity, userId]);
      }

      provisioned++;
      if (provisioned % 10 === 0) console.log(`[fullflow-v5] ...${provisioned}/${admins.length} provisioned`);
    }

    console.log(`[fullflow-v5] provisioned ${provisioned} admin accounts: cowork_messages=${msgN}, classifications=${classN}, code_sessions=${codeSessN}, weekly_code_metrics=${weeklyN}, events=${eventN}, skills=${skillN}, mcp=${mcpN}.`);

    // ── Reset aggregator cursors ─────────────────────────────────────────────
    for (const key of ['pulse_aggregator_last_run', 'pulse_aggregator_daily_last_run', 'code_aggregator_last_run']) {
      await c.query(`INSERT INTO config (key, value) VALUES ($1, '') ON CONFLICT (key) DO UPDATE SET value = ''`, [key]);
    }
    console.log('[fullflow-v5] aggregator cursors reset — rolling snapshots recompute within ~60s.');
    console.log('[fullflow-v5] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

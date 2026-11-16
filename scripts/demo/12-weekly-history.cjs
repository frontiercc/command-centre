// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample data: the all-products weekly history (pulse_metrics, granularity
// 'week'), worked out last, once every sample prompt is in and graded.
// 01-organisation.cjs writes a first version, but later steps add the
// follow-up prompts (10-conversations.cjs) and the ChatGPT prompts
// (11-chatgpt-codex.ts), so without this the All view's past weeks would
// count fewer prompts than the Claude and OpenAI views. Same counts and same
// department rule as 01-organisation.cjs. Developer Pulse's weekly history
// (code_metrics) is recounted the same way, below. Run by scripts/demo/load.cjs,
// with tsx.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');

const WEEK = 7 * 86400;
// Every completed week the sample reaches back over (90 days, inside 14 weeks).
const WEEKS = 14;

function weekStart(ts) {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

const COUNTS = `SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
  SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
  SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3,
  COUNT(*) AS total`;

const UPSERT = `INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, dds, event_count, tier_1_count, tier_2_count, tier_3_count, computed_at, granularity)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'week')
  ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity = 'week'
  DO UPDATE SET period_end = EXCLUDED.period_end, dds = EXCLUDED.dds, event_count = EXCLUDED.event_count,
    tier_1_count = EXCLUDED.tier_1_count, tier_2_count = EXCLUDED.tier_2_count, tier_3_count = EXCLUDED.tier_3_count,
    computed_at = EXCLUDED.computed_at`;

(async () => {
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await db.connect();
  const now = Math.floor(Date.now() / 1000);
  const current = weekStart(now);
  let users = 0, departments = 0;

  // Clear the completed weeks first: an earlier step's row for someone with no
  // graded prompts left that week would otherwise stay behind.
  await db.query(
    `DELETE FROM pulse_metrics WHERE granularity = 'week' AND scope_type IN ('user', 'function')
       AND period_start >= $1 AND period_start < $2`, [current - WEEKS * WEEK, current]);

  const write = async (scopeType, scopeId, wStart, row) => {
    const total = Number(row.total ?? 0);
    if (total === 0) return false;
    const t1 = Number(row.t1 ?? 0), t2 = Number(row.t2 ?? 0), t3 = Number(row.t3 ?? 0);
    await db.query(UPSERT, [scopeType, scopeId, wStart, wStart + WEEK - 1, (3 * t3 + 2 * t2 + t1) / total, total, t1, t2, t3, now]);
    return true;
  };

  for (let weeksAgo = WEEKS; weeksAgo >= 1; weeksAgo--) {
    const wStart = current - weeksAgo * WEEK;
    const wEnd = wStart + WEEK - 1;
    const perUser = await db.query(
      `SELECT pc.user_id, ${COUNTS}
         FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
        WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= $1 AND cm.occurred_at <= $2
        GROUP BY pc.user_id`, [wStart, wEnd]);
    for (const row of perUser.rows) if (row.user_id && await write('user', row.user_id, wStart, row)) users++;

    const perDept = await db.query(
      `SELECT u.department, ${COUNTS}
         FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
         JOIN users u ON u.id = pc.user_id
        WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= $1 AND cm.occurred_at <= $2
          AND u.department IS NOT NULL AND u.department <> ''
        GROUP BY u.department`, [wStart, wEnd]);
    for (const row of perDept.rows) if (await write('function', row.department, wStart, row)) departments++;
  }

  console.log(`${users} person weeks and ${departments} department weeks of all-products history.`);

  // Developer Pulse's weekly history (code_metrics, granularity 'week'), worked
  // out the same way: 01-organisation.cjs and 02-your-account.cjs write a first
  // version from their own rows, before later steps add sessions, prompts and
  // Codex. Each completed week is recounted from the session figures, as the
  // Hub's code aggregator writes a week (lib/pulse/code/aggregator.ts): a
  // session counts in the week of its last activity; organisation, person, team
  // and department; spend priced with the Hub's rates.
  try {
    // Needs tsx (load.cjs runs this file with it); under plain node this step is skipped.
    const rates = await import(pathToFileURL(path.join(__dirname, '../../lib/pulse/code/rates.ts')).href);
    const getRates = rates.getCodeModelRates || rates.default.getCodeModelRates;
    const priceTokens = rates.priceTokens || rates.default.priceTokens;
    const modelRates = await getRates();
    const weeks = await rebuildCodeWeeks(db, current, now, modelRates, priceTokens);
    console.log(`${weeks.rows} Developer Pulse weekly rows over ${weeks.weeks} weeks.`);
  } catch (e) {
    console.error(`Developer Pulse weekly history not recounted (${e.message}).`);
  }
  await db.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

/** Recount code_metrics' completed weeks from code_session_stats. Returns how many rows it wrote. */
async function rebuildCodeWeeks(db, current, now, modelRates, priceTokens) {
  const from = current - WEEKS * WEEK;
  await db.query(
    `DELETE FROM code_metrics WHERE granularity = 'week' AND scope_type IN ('organisation', 'user', 'team', 'function')
       AND period_start >= $1 AND period_start < $2`, [from, current]);
  const sessions = (await db.query(
    `SELECT session_id, user_id, repo, user_msg_count, tool_use_count, error_count, commit_count, input_tokens,
            output_tokens, cache_creation_tokens, cache_read_tokens, models_json, last_at
       FROM code_session_stats WHERE last_at >= $1 AND last_at < $2`, [from, current])).rows;
  const teams = new Map();
  for (const r of (await db.query(`SELECT id, team_id FROM users WHERE team_id IS NOT NULL`)).rows) {
    if (!teams.has(r.team_id)) teams.set(r.team_id, new Set());
    teams.get(r.team_id).add(r.id);
  }
  const depts = new Map();
  const addMember = (d, id) => { if (!depts.has(d)) depts.set(d, new Set()); depts.get(d).add(id); };
  for (const r of (await db.query(`SELECT id, department FROM users WHERE department IS NOT NULL AND department <> ''`)).rows) addMember(r.department, r.id);
  for (const r of (await db.query(`SELECT linked_cowork_user_id AS id, department FROM admin_users
      WHERE department IS NOT NULL AND department <> '' AND linked_cowork_user_id IS NOT NULL`)).rows) addMember(r.department, r.id);

  const scopeFigures = (rows) => {
    let inp = 0, outp = 0, cw = 0, cr = 0, tools = 0, msgs = 0, errors = 0, commits = 0, spend = 0, priced = false;
    const repos = new Set();
    for (const s of rows) {
      inp += Number(s.input_tokens); outp += Number(s.output_tokens); cw += Number(s.cache_creation_tokens); cr += Number(s.cache_read_tokens);
      tools += Number(s.tool_use_count); msgs += Number(s.user_msg_count); errors += Number(s.error_count); commits += Number(s.commit_count);
      if (s.repo) repos.add(s.repo);
      try {
        for (const [model, u] of Object.entries(JSON.parse(s.models_json || '{}'))) {
          const usd = priceTokens(model, { inputTokens: u.input, outputTokens: u.output, cacheCreationTokens: u.cache_creation, cacheReadTokens: u.cache_read }, modelRates);
          if (usd !== null) { spend += usd; priced = true; }
        }
      } catch { /* an unreadable model list is left unpriced */ }
    }
    return {
      spend: priced ? spend : (inp + outp + cw + cr > 0 ? null : 0),
      inp, outp, cacheHit: cr + inp > 0 ? cr / (cr + inp) : null, autonomy: msgs > 0 ? tools / msgs : null,
      sessions: rows.length, repos: repos.size, commits, friction: tools > 0 ? errors / tools : null,
    };
  };

  let written = 0, weeks = 0;
  for (let wStart = from; wStart < current; wStart += WEEK) {
    const wEnd = wStart + WEEK;
    const inWeek = sessions.filter((s) => Number(s.last_at) >= wStart && Number(s.last_at) < wEnd);
    if (inWeek.length === 0) continue;
    weeks++;
    const write = async (scopeType, scopeId, rows, memberIds) => {
      if (rows.length === 0) return;
      const m = scopeFigures(rows);
      const skill = (await db.query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN i.invocation_type = 'agent_chained' THEN 1 ELSE 0 END) AS chained
           FROM cowork_skill_invocations i JOIN code_session_stats s ON s.session_id = i.session_id
          WHERE i.user_id = ANY($1) AND i.occurred_at >= $2 AND i.occurred_at < $3`, [memberIds, wStart, wEnd])).rows[0];
      const o = (await db.query(
        `SELECT COALESCE(SUM(CASE WHEN metric_name = 'claude_code.active_time.total' AND type = 'user' THEN value END), 0) AS atu,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.active_time.total' AND type = 'cli' THEN value END), 0) AS atc,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.lines_of_code.count' AND type = 'added' THEN value END), 0) AS la,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.lines_of_code.count' AND type = 'removed' THEN value END), 0) AS lr,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.pull_request.count' THEN value END), 0) AS prc,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.code_edit_tool.decision' AND type = 'accept' THEN value END), 0) AS ea,
                COALESCE(SUM(CASE WHEN metric_name = 'claude_code.code_edit_tool.decision' AND type = 'reject' THEN value END), 0) AS er
           FROM code_otel_metrics WHERE user_id = ANY($1) AND occurred_at >= $2 AND occurred_at < $3`, [memberIds, wStart, wEnd])).rows[0];
      await db.query(
        `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, input_tokens, output_tokens, cache_hit_ratio,
           autonomy_ratio, session_count, repo_count, commit_count, skill_leverage, friction_index, active_time_user_s, active_time_cli_s,
           lines_added, lines_removed, pr_count, edit_accept_count, edit_reject_count, computed_at, granularity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'week')`,
        [scopeType, scopeId, wStart, wEnd - 1, m.spend === null ? null : String(m.spend), m.inp, m.outp, m.cacheHit, m.autonomy,
          m.sessions, m.repos, m.commits, Number(skill.total) > 0 ? Number(skill.chained) / Number(skill.total) : null, m.friction,
          Math.round(Number(o.atu)), Math.round(Number(o.atc)), Math.round(Number(o.la)), Math.round(Number(o.lr)),
          Math.round(Number(o.prc)), Math.round(Number(o.ea)), Math.round(Number(o.er)), now]);
      written++;
    };
    const people = [...new Set(inWeek.map((s) => s.user_id).filter(Boolean))];
    await write('organisation', 'org', inWeek, people);
    for (const id of people) await write('user', id, inWeek.filter((s) => s.user_id === id), [id]);
    for (const [team, members] of teams) await write('team', team, inWeek.filter((s) => members.has(s.user_id)), [...members]);
    for (const [dept, members] of depts) await write('function', dept, inWeek.filter((s) => members.has(s.user_id)), [...members]);
  }
  return { rows: written, weeks };
}

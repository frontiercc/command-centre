// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Loads sample data: a fictional organisation and its activity, so every
// page of Command Centre has something to show: Claude Code, Cowork and Chat,
// and ChatGPT and Codex (11-chatgpt-codex.ts, written through the OpenAI
// sync's own code).
//
// It adds the organisation's fictional people (Acme Corp UK,
// acme-people.json) first, then runs the sample scripts in order, each
// after clearing the grades on that script's earlier rows. It also switches
// on the features the sample data shows, and asks the Hub's scheduled jobs to
// run again now, so the pages fill in within a few minutes.
//
// Run it with Docker Compose, after creating your admin account (your own
// account then gets activity too):
//
//   docker compose --profile demo run --rm demo-data
//
// The scripts mark the rows they add and can be run again. Some also change
// existing rows: they give admin accounts a department and sample activity,
// and replace thin evidence on existing personal-data and intent alerts. Use
// them only on an installation for exploring; start a fresh database for real
// telemetry. To protect real data, the loader refuses to run once real Claude
// Code, Cowork or Chat data has reached this installation, unless it is run
// with SAMPLE_DATA_FORCE=1:
//
//   docker compose --profile demo run --rm -e SAMPLE_DATA_FORCE=1 demo-data
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Client } = require('pg');

// [marker prefix on the sample rows, script]. Order matters: later scripts
// build on what earlier ones wrote.
const STEPS = [
  ['ff-', '01-organisation.cjs'],
  ['ff2-', '01b-follow-up-2.cjs'],
  ['ff3-', '01c-follow-up-3.cjs'],
  ['ff5-', '02-your-account.cjs'],
  ['ff9-', '03-skill-workflows.cjs'],
  ['ff6-', '04-alerts.cjs'],
  ['ff7-', '05-chat.cjs'],
  ['seedme-cwme-', '06-model-efficiency.cjs'],
  ['ff8-', '07-attribution.cjs'],
  ['ff10-', '08-session-stats.cjs'],
  // Claude in Office runs before human time, which also gives its sessions Claude time.
  ['ff14-', '09b-office.cjs'],
  ['ff11-', '09-human-time.cjs'],
  ['ff13-', '10-conversations.cjs'],
];

// The feature switches the sample data shows (all but single sign-on, which
// needs an identity provider). Its demo Dev Framework Alignment scores also
// need CCC_DX_ALLOW_MOCK on the Hub. The demo FinOps Enterprise figures are
// left off: they do not match the sample's own spend, so the reconciliation
// check raised a High alert ("94% drift") on every load.
const SWITCHES = [
  ['chargeback_enabled', 'true'],
  ['code_alert_cost_spike_enabled', 'true'],
  ['code_alert_friction_enabled', 'true'],
  ['code_alert_model_policy_enabled', 'false'],
  ['code_alert_repo_exposure_enabled', 'false'],
  ['code_classifier_enabled', 'true'],
  ['code_pulse_enabled', 'true'],
  ['dx_framework_enabled', 'true'],
  ['dx_framework_mock', 'true'],
  ['finance_model_efficiency_enabled', 'true'],
  ['highlights_enabled', 'true'],
  ['human_time_enabled', 'true'],
  ['pulse_enabled', 'true'],
  ['risk_alert_adoption_enabled', 'true'],
  ['risk_alert_anomaly_enabled', 'true'],
  ['risk_alert_policy_enabled', 'true'],
  ['risk_alert_pulse_capability_enabled', 'false'],
  ['risk_alert_risk_enabled', 'true'],
  ['use_cases_enabled', 'true'],
];

// Scheduled jobs that may have run before the sample data existed. Clearing
// their last-run times makes the Hub run them again on its next cycle. The two
// recount markers make it recount every past week of the per-product (Claude,
// OpenAI) weekly history, not only the weeks graded or changed since its last run:
// the sample's grades and sessions are back-dated, so they never count as new.
const RERUN_JOBS = ['cowork_session_agg_last_run', 'pulse_aggregator_last_run',
  'pulse_aggregator_daily_last_run', 'code_aggregator_last_run',
  'pulse_vendor_weeks_graded_since', 'code_vendor_weeks_changed_since'];

// The sample's own marker prefixes, for its sessions, prompts and alerts. 'ff-'
// also covers the Team Coaching and So What people (ff-coach-, ff-sw-).
const SAMPLE_LIKE = STEPS.map(([prefix]) => `${prefix}%`);

// Board entries earlier versions of the sample added and no longer do: Claude's
// own connectors (never a board entry), lower-case copies of Anthropic's
// connectors, and skills named as Anthropic's that Anthropic does not publish.
const REMOVED_BOARD_ENTRIES = [
  'workspace', 'cowork', 'Claude_in_Chrome', 'File Creation', 'Dynamic Widget', 'ccd_session', 'ccd_session_mgmt', 'visualize',
  'slack', 'salesforce', 'google-drive',
  'anthropic-skills:prime-directives', 'anthropic-skills:bug-finder', 'anthropic-skills:test-gen', 'anthropic-skills:architect',
  'anthropic-skills:diagram', 'anthropic-skills:sequential-thinking', 'anthropic-skills:data-analyst', 'anthropic-skills:memory',
  'anthropic-skills:web-fetch', 'anthropic-skills:code-review',
];

const PEOPLE_COLUMNS = ['id', 'email', 'display_name', 'department', 'source', 'first_seen_at', 'last_seen_at',
  'created_at', 'team_id', 'manager_id', 'account_uuid', 'deactivated_at', 'deactivation_reason'];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env: process.env });

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await db.connect();

  // Real data guard. The Hub records the first real Claude Code and Cowork
  // telemetry it receives, and each Compliance API sync of Chat; sample data
  // never sets these, because it writes straight to the tables. Those records
  // can be missing (telemetry from before they existed, or a Compliance key
  // since removed), so any Cowork, Claude Code or Chat message whose id does
  // not carry a sample prefix also counts as real. All three live in
  // cowork_messages (Claude Chat as surface 'chat' since migration 0041).
  // The OpenAI sync records its first real prompt (setup_first_openai_at); the
  // sample's ChatGPT and Codex rows go through the sync's code but never set
  // it, so OpenAI rows count as real only once that record exists.
  const markers = await db.query(
    "SELECT key FROM config WHERE key IN ('setup_first_code_at', 'setup_first_cowork_at', 'compliance_last_sync_at', 'setup_first_openai_at')");
  const samplePatterns = STEPS.map(([prefix]) => `${prefix}%`);
  const notSample = samplePatterns.map((_, i) => `id NOT LIKE $${i + 1}`).join(' AND ');
  const real = await db.query(
    `SELECT COUNT(*)::int AS n FROM cowork_messages WHERE ${notSample}
       AND (source IS NULL OR source NOT IN ('chatgpt_chat', 'chatgpt_work', 'codex'))`, samplePatterns);
  const realMessages = real.rows[0].n;
  if ((markers.rows.length > 0 || realMessages > 0) && process.env.SAMPLE_DATA_FORCE !== '1') {
    console.error('This installation already holds real Claude data, so sample data was not loaded.');
    console.error('Sample data mixes invented activity into existing records. Use it only on an');
    console.error('installation for exploring: start a fresh one with `docker compose down -v`.');
    console.error('To load it here anyway, run the command again with -e SAMPLE_DATA_FORCE=1.');
    await db.end();
    process.exit(1);
  }

  console.log('Adding the sample people...');
  const people = require('./acme-people.json');
  for (const p of people) {
    const cols = PEOPLE_COLUMNS.join(', ');
    const params = PEOPLE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`INSERT INTO users (${cols}) VALUES (${params}) ON CONFLICT DO NOTHING`, PEOPLE_COLUMNS.map((c) => p[c]));
  }
  console.log(`${people.length} people.`);

  // The sample covers 13 weeks, so keep at least 90 days. Only ever raise a
  // shorter retention period; a longer one is left as it is.
  for (const key of ['retention_cowork_days', 'retention_code_days']) {
    await db.query("UPDATE config SET value = '90' WHERE key = $1 AND CASE WHEN value ~ '^[0-9]{1,9}$' THEN value::int < 90 ELSE false END", [key]);
  }

  // The Team Coaching and So What people (13-team-coaching.cjs, 14-so-what.cjs)
  // must have only the activity those scripts give them. The other scripts give
  // everyone with a department activity, so take theirs away until those two
  // run, last.
  await db.query("UPDATE admin_users SET department = NULL WHERE linked_cowork_user_id LIKE 'ff-coach-%' OR linked_cowork_user_id LIKE 'ff-sw-%'");
  await db.query("UPDATE users SET department = NULL WHERE id LIKE 'ff-coach-%' OR id LIKE 'ff-sw-%'");
  // And clear their sessions from the last load, which later scripts would otherwise add to.
  // The same for the scripts that add rows to other scripts' sessions (spend,
  // timing events, follow-up prompts): cleared now, the last load's rows cannot
  // keep last load's sessions alive while the earlier scripts look for sessions.
  for (const script of ['13-team-coaching.cjs', '14-so-what.cjs', '08-session-stats.cjs', '09-human-time.cjs', '10-conversations.cjs']) {
    try { run('node', [path.join(__dirname, script), '--clean']); }
    catch { console.error(`${script} --clean failed; continuing with the rest.`); }
  }

  for (const [prefix, script] of STEPS) {
    // Command Centre grades sample messages like any others. Clear those
    // grades first, or a re-run cannot replace the messages they belong to.
    await db.query('DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1', [prefix + '%']);
    await db.query('DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1', [prefix + '%']);
    console.log(`\nRunning ${script}...`);
    try { run('node', [path.join(__dirname, script)]); }
    catch { console.error(`${script} failed; continuing with the rest.`); }
  }

  // ChatGPT and Codex: the same Acme Corp people, through the OpenAI sync's code.
  console.log('\nAdding ChatGPT and Codex activity...');
  try { run('npx', ['tsx', path.join(__dirname, '11-chatgpt-codex.ts')]); }
  catch { console.error('11-chatgpt-codex.ts failed; continuing with the rest.'); }

  // Most sample scripts place their prompts at any hour, so over half the sample's Work Pulse
  // work fell in the evening or at the weekend, which no real organisation looks like. Move each
  // sample Claude session that starts out of hours to a working hour (9am to 5pm, the
  // organisation's timezone) on the same day, or the Friday before for a weekend. A whole session
  // moves together, so its length, its week and its order are kept. ChatGPT's sample is already
  // in working hours and is left alone, as are the Team Coaching and So What people, who are
  // placed in working hours by their own scripts below.
  console.log('\nKeeping the sample to working hours...');
  try {
    const db4 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db4.connect();
    const tz = (await db4.query(`SELECT value FROM config WHERE key = 'telemetry_silence_timezone'`)).rows[0]?.value || 'Europe/London';
    const nowS4 = Math.floor(Date.now() / 1000);
    await db4.query('BEGIN');
    await db4.query(`
      CREATE TEMP TABLE wh ON COMMIT DROP AS
      SELECT session_id, start_at, (to_timestamp(start_at) AT TIME ZONE $1) AS local_start
      FROM (SELECT session_id, MIN(occurred_at) AS start_at FROM cowork_messages
            WHERE session_id IS NOT NULL AND surface IN ('cowork', 'chat')
              AND (source IS NULL OR source NOT IN ('chatgpt_chat', 'chatgpt_work', 'codex'))
              AND (id LIKE 'ff%' OR id LIKE 'seedme%')
              AND id NOT LIKE 'ff-coach-%' AND id NOT LIKE 'ff-sw-%'
            GROUP BY session_id) s`, [tz]);
    await db4.query(`ALTER TABLE wh ADD COLUMN delta bigint`);
    // Weekdays 9am to 5pm stay; anything else moves to 9am plus up to eight hours, the minute
    // spread by the session's own id, on the same day or the Friday before a weekend.
    await db4.query(`
      UPDATE wh SET delta = CASE
        WHEN extract(isodow FROM local_start) BETWEEN 1 AND 5 AND extract(hour FROM local_start) BETWEEN 9 AND 16 THEN 0
        ELSE (extract(epoch FROM (
               (date_trunc('day', local_start)
                 - (CASE extract(isodow FROM local_start) WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 0 END) * interval '1 day'
                 + interval '9 hours' + (abs(hashtext(session_id)) % 28800) * interval '1 second')
               AT TIME ZONE $1)) - start_at)::bigint
      END`, [tz]);
    // Never into the future: a session moved past now goes back a day.
    await db4.query(`UPDATE wh SET delta = delta - 86400 WHERE start_at + delta > $1`, [nowS4 - 3600]);
    await db4.query(`DELETE FROM wh WHERE delta = 0`);
    const moved = (await db4.query(`SELECT COUNT(*) AS n FROM wh`)).rows[0].n;
    // Only the session's start is kept out of the future above, so every moved time is also capped
    // at now. LEAST skips nulls, so a time that was not set stays not set.
    const moved4 = (col) => `CASE WHEN ${col} IS NULL THEN NULL ELSE LEAST(${col} + wh.delta, $1::bigint) END`;
    await db4.query(`UPDATE cowork_messages m SET occurred_at = ${moved4('m.occurred_at')} FROM wh WHERE m.session_id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE chat_assistant_meta a SET occurred_at = ${moved4('a.occurred_at')} FROM wh WHERE a.conversation_id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE cowork_session_stats s SET first_event_at = ${moved4('s.first_event_at')}, last_event_at = ${moved4('s.last_event_at')} FROM wh WHERE s.session_id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE cowork_sessions s SET started_at = ${moved4('s.started_at')}, ended_at = ${moved4('s.ended_at')} FROM wh WHERE s.id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE cowork_skill_invocations i SET occurred_at = ${moved4('i.occurred_at')} FROM wh WHERE i.session_id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE cowork_mcp_invocations i SET occurred_at = ${moved4('i.occurred_at')} FROM wh WHERE i.session_id = wh.session_id`, [nowS4]);
    await db4.query(`UPDATE pulse_classifications p SET classified_at = ${moved4('p.classified_at')} FROM cowork_messages m, wh WHERE p.cowork_message_id = m.id AND m.session_id = wh.session_id`, [nowS4]);
    await db4.query('COMMIT');
    await db4.end();
    console.log(`${moved} sessions moved into working hours (${tz}).`);
  } catch (e) { console.error(`Working hours step failed (${e.message}); continuing with the rest.`); }

  // Team Coaching people, after every other script so none adds to their activity.
  console.log('\nAdding the Team Coaching people...');
  try { run('node', [path.join(__dirname, '13-team-coaching.cjs')]); }
  catch { console.error('13-team-coaching.cjs failed; continuing with the rest.'); }

  // So What's cards, after Team Coaching for the same reason.
  console.log('\nAdding the So What people and decisions...');
  try { run('node', [path.join(__dirname, '14-so-what.cjs')]); }
  catch { console.error('14-so-what.cjs failed; continuing with the rest.'); }

  // The sample's activity starts inside the quarter, so every skill and
  // connector would read as first used this quarter ("new"). Give each one,
  // bar the one first used most recently for each of Claude and ChatGPT, a
  // use from before the quarter: a copy of its first use, 100 to 114 days ago.
  // Work Pulse's tools only (not Claude Code or Codex). Marked ffold- so a
  // re-run replaces exactly these.
  console.log('\nAdding older skill and connector use...');
  try {
    let older = 0;
    for (const [table, col, extra] of [
      ['cowork_skill_invocations', 'skill_name', 'invocation_type'],
      ['cowork_mcp_invocations', 'mcp_server', 'mcp_tool, success'],
    ]) {
      await db.query(`DELETE FROM ${table} WHERE id LIKE 'ffold-%'`);
      const res = await db.query(`
        WITH firsts AS (
          SELECT DISTINCT ON (${col}, v) *
          FROM (SELECT *, CASE WHEN source IN ('chatgpt_chat', 'chatgpt_work') THEN 'openai' ELSE 'claude' END AS v
                FROM ${table}
                WHERE surface IS DISTINCT FROM 'code' AND source IS DISTINCT FROM 'codex' AND ${col} IS NOT NULL) t
          ORDER BY ${col}, v, occurred_at),
        ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY v ORDER BY occurred_at DESC) AS rn FROM firsts)
        INSERT INTO ${table} (id, user_id, session_id, ${col}, occurred_at, ingested_at, ${extra}, source, surface)
        SELECT 'ffold-' || md5(id), user_id, session_id, ${col},
               $1::bigint - (100 + abs(hashtext(id)) % 15) * 86400, $1::bigint - (100 + abs(hashtext(id)) % 15) * 86400,
               ${extra}, source, surface
        FROM ranked WHERE rn > 1
        ON CONFLICT (id) DO NOTHING`, [Math.floor(Date.now() / 1000)]);
      older += res.rowCount;
    }
    console.log(`${older} skills and connectors given an earlier use.`);
  } catch (e) { console.error(`Older skill and connector use failed (${e.message}); continuing with the rest.`); }

  // GitHub commits made with Claude Code, with Codex and with no AI tool
  // recorded, from the sample's own Claude Code and Codex commits.
  console.log('\nSplitting the sample GitHub commits by tool...');
  try {
    const split = await require('./github-tool-split.cjs').fillGithubToolSplit(db);
    console.log(`${split.claude} made with Claude Code, ${split.codex} with Codex, ${split.none} with no AI tool recorded.`);
  } catch (e) { console.error(`GitHub tool split failed (${e.message}); continuing with the rest.`); }

  // Tie how much each person ships to how they work, so the sample can carry the
  // comparison So what is built on. Runs after the split, which it keeps in shape.
  console.log('\nTying the sample GitHub commits to how its people work...');
  try {
    const tied = await require('./github-depth.cjs').tieGithubToDepth(db);
    console.log(`${tied.deepPerPerson} commits each for the ${tied.deep.people} who hand whole work over, ${tied.shallowPerPerson} for the other ${tied.shallow.people}.`);
  } catch (e) { console.error(`GitHub depth tie failed (${e.message}); continuing with the rest.`); }

  // The sample S&C Board entries, use cases (with their weekly figures and
  // matches) and department process suggestions. Nothing in them is tied to
  // anyone outside the fictional organisation.
  console.log('\nAdding the sample S&C Board, use cases and suggestions...');
  // The bundled file was exported on fixed dates. Move every date forward by
  // whole weeks so its last week becomes the last completed week before
  // loading: use cases, their weekly figures and matches, the S&C Board and
  // the suggestions then look current whenever the sample is loaded, and
  // every week still starts on a Monday.
  const raw = require('./demo-hub-board-and-use-cases.json');
  const WEEK_S = 7 * 86400;
  const nowS = Math.floor(Date.now() / 1000);
  const today = new Date(nowS * 1000);
  const thisWeek = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000
    - ((today.getUTCDay() + 6) % 7) * 86400;
  const fileLastWeek = Math.max(...raw.weeks.map((w) => Number(w.week_start)));
  const shift = (thisWeek - WEEK_S) - fileLastWeek;
  const isDate = (k) => k === 'week_start' || k.endsWith('_at');
  const moveRow = (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (isDate(k) && typeof v === 'number') out[k] = v + shift;
      else if (k === 'activate_result' && typeof v === 'string') {
        // The stored activity snapshot carries its own last-seen date.
        try {
          const j = JSON.parse(v);
          if (typeof j.lastSeenAt === 'number') j.lastSeenAt += shift;
          out[k] = JSON.stringify(j);
        } catch { out[k] = v; }
      } else out[k] = v;
    }
    return out;
  };
  const extra = Object.fromEntries(Object.entries(raw).map(([table, rows]) => [table, rows.map(moveRow)]));
  const asParam = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  // `refresh` columns are rewritten from the file on a re-run, so a corrected
  // description or citation replaces the one an earlier load wrote.
  const insertRows = async (table, rows, refresh = []) => {
    let n = 0;
    for (const r of rows) {
      const cols = Object.keys(r);
      const onConflict = refresh.length
        ? `ON CONFLICT (id) DO UPDATE SET ${refresh.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
        : 'ON CONFLICT DO NOTHING';
      const res = await db.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${onConflict}`,
        cols.map((c) => asParam(r[c])));
      n += res.rowCount;
    }
    return n;
  };
  const removedN = (await db.query(
    'DELETE FROM skill_library_entries WHERE name = ANY($1) AND author_user_id IS NULL', [REMOVED_BOARD_ENTRIES])).rowCount;
  if (removedN) console.log(`${removedN} board entries an earlier load added removed.`);
  const boardN = await insertRows('skill_library_entries', extra.library);
  const ucN = await insertRows('use_cases', extra.use_cases, ['title', 'description', 'pain_point', 'value_hypothesis']);
  const weekN = await insertRows('use_case_activation_weeks', extra.weeks);
  const sugN = await insertRows('use_case_suggestions', extra.suggestions, ['description', 'cited_sessions']);
  const matches = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'demo-hub-use-case-matches.json.gz'))).toString('utf8'))
    .map((m) => [m[0], Number(m[1]) + shift, m[2], m[3]]);
  let matchN = 0;
  for (let i = 0; i < matches.length; i += 5000) {
    const part = matches.slice(i, i + 5000);
    const res = await db.query(
      `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id)
       SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
      [part.map((m) => m[0]), part.map((m) => m[1]), part.map((m) => m[2]), part.map((m) => m[3])]);
    matchN += res.rowCount;
  }
  console.log(`${boardN} board entries, ${ucN} use cases (${weekN} weekly rows, ${matchN} matches), ${sugN} suggestions.`);

  for (const [key, value] of SWITCHES) {
    await db.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  await db.query('DELETE FROM config WHERE key = ANY($1)', [RERUN_JOBS]);
  await db.end();

  // At ingest the Hub puts every skill and connector it sees on the S&C Board:
  // Anthropic's own skills published, others unclaimed, and Claude's built-in
  // connectors left off (lib/otel/cowork-receiver.ts). The sample data writes
  // its activity straight to the tables, so add those entries the same way,
  // with the Hub's own list of Anthropic skills.
  console.log('\nAdding the skills and connectors in use to the S&C Board...');
  run('npx', ['tsx', '-e', [
    "import('./lib/library/known-anthropic-skills.ts').then(async (k) => {",
    "  const known = [...(k.KNOWN_ANTHROPIC_SKILLS || k.default.KNOWN_ANTHROPIC_SKILLS)];",
    "  const pg = (await import('pg')).default;",
    "  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;",
    "  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });",
    "  await db.connect();",
    "  const now = Math.floor(Date.now() / 1000);",
    "  const skills = await db.query(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, created_at, updated_at)",
    "    SELECT DISTINCT skill_name, 'skill', 'cowork', CASE WHEN skill_name = ANY($1) THEN 'anthropic' ELSE 'org' END,",
    "      CASE WHEN skill_name = ANY($1) THEN 1 ELSE 0 END, $2::bigint, $2::bigint",
    "    FROM cowork_skill_invocations WHERE skill_name IS NOT NULL AND skill_name <> ''",
    "    ON CONFLICT (name) DO NOTHING`, [known, now]);",
    "  const connectors = await db.query(`INSERT INTO skill_library_entries (name, type, surface, source, is_published, created_at, updated_at)",
    "    SELECT DISTINCT mcp_server, 'connector', 'cowork', 'org', 0, $1::bigint, $1::bigint",
    "    FROM cowork_mcp_invocations WHERE mcp_server IS NOT NULL AND mcp_server <> ''",
    "      AND mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')",
    "    ON CONFLICT (name) DO NOTHING`, [now]);",
    "  console.log(skills.rowCount + ' skills and ' + connectors.rowCount + ' connectors added.');",
    "  // Anthropic's skills get the Hub's built-in description where they have none, as at ingest.",
    "  const entries = (k.anthropicSkillDescriptionEntries || k.default.anthropicSkillDescriptionEntries)();",
    "  let described = 0;",
    "  for (const [name, d] of entries) {",
    "    const r = await db.query(`UPDATE skill_library_entries SET description = $2 WHERE name = $1 AND source = 'anthropic' AND (description IS NULL OR description = '')`, [name, d]);",
    "    described += r.rowCount;",
    "  }",
    "  console.log(described + ' Anthropic skills described.');",
    "  await db.end();",
    "  process.exit(0);",
    "}).catch((e) => { console.error(e); process.exit(1); });",
  ].join('\n')]);

  // The Hub works out per-session figures (time, cost, tokens, model) 500
  // sessions an hour. Work them all out now with the same code, so every
  // conversation shows its figures as soon as the sample data is loaded.
  console.log('\nWorking out session figures...');
  run('npx', ['tsx', '-e', [
    "import('./lib/pulse/cowork/session-aggregator.ts').then(async (m) => {",
    '  let total = 0;',
    '  for (let i = 0; i < 20; i++) {',
    '    const r = await (m.aggregateCoworkSessionStats || m.default.aggregateCoworkSessionStats)();',
    '    total += r.sessionsUpserted;',
    '    if (!r.remaining) break;',
    '  }',
    "  console.log(total + ' sessions.');",
    '  process.exit(0);',
    '}).catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n')]);

  // On a real installation every session the Hub counts was built from the
  // prompts it received. Remove any sample session left with no prompt behind
  // it (a session from an earlier load, or one a script left empty), with the
  // events in it, so the Hub's own jobs do not build it again. Expected to
  // find none from this load.
  console.log('\nRemoving sample sessions with no prompt...');
  try {
    const db5 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db5.connect();
    const noCoworkPrompt = (col) => `${col} LIKE ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM cowork_messages p
      WHERE p.session_id = ${col} AND p.message_type = 'cowork_user_message')`;
    const noCodePrompt = (col) => `${col} LIKE ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM cowork_messages p
      WHERE p.session_id = ${col} AND p.message_type IN ('code_user_message', 'cowork_user_message'))`;
    const cwEvents = (await db5.query(`DELETE FROM cowork_messages m WHERE m.message_type IN
      ('cowork_api_request', 'cowork_tool_metadata', 'cowork_tool_summary') AND ${noCoworkPrompt('m.session_id')}`, [SAMPLE_LIKE])).rowCount;
    const cwStats = (await db5.query(`DELETE FROM cowork_session_stats s WHERE ${noCoworkPrompt('s.session_id')}`, [SAMPLE_LIKE])).rowCount;
    await db5.query(`DELETE FROM cowork_sessions s WHERE ${noCoworkPrompt('s.id')}
      AND NOT EXISTS (SELECT 1 FROM cowork_messages m WHERE m.session_id = s.id)`, [SAMPLE_LIKE]);
    const cdEvents = (await db5.query(`DELETE FROM code_assistant_meta a WHERE ${noCodePrompt('a.session_id')}`, [SAMPLE_LIKE])).rowCount;
    await db5.query(`DELETE FROM code_session_classifications c WHERE ${noCodePrompt('c.session_id')}`, [SAMPLE_LIKE]);
    const cdStats = (await db5.query(`DELETE FROM code_session_stats s WHERE ${noCodePrompt('s.session_id')}`, [SAMPLE_LIKE])).rowCount;
    const left = (await db5.query(`
      SELECT (SELECT COUNT(*) FROM cowork_session_stats WHERE session_id LIKE ANY($1::text[])) AS cowork,
             (SELECT COUNT(*) FROM code_session_stats WHERE session_id LIKE ANY($1::text[])) AS code`, [SAMPLE_LIKE])).rows[0];
    await db5.end();
    console.log(`${cwStats} Cowork and ${cdStats} Claude Code sessions removed (${cwEvents + cdEvents} events in them); ${left.cowork} Cowork and ${left.code} Claude Code sample sessions, each with a prompt.`);
  } catch (e) { console.error(`Removing sessions with no prompt failed (${e.message}); continuing with the rest.`); }

  // The all-products weekly history, worked out now that every prompt is in.
  // Run with tsx: the Claude Code weeks are priced with the Hub's own rates.
  console.log('\nWorking out the weekly history...');
  try { run('npx', ['tsx', path.join(__dirname, '12-weekly-history.cjs')]); }
  catch { console.error('12-weekly-history.cjs failed; continuing.'); }

  // Team Coaching on both Pulses: for every team, an action marked done 35 days ago (its follow-up
  // shows), one marked done 5 days ago (waiting for its check) and one done 40 days ago that the
  // plan no longer suggests ("Done before"). The figures they were saved with are sample values.
  // Marked done by a sample lead, so a re-run replaces exactly these.
  console.log('\nMarking sample Team Coaching actions done...');
  {
    const db3 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db3.connect();
    const by = 'team.lead@acmecorp.example';
    const nowS3 = Math.floor(Date.now() / 1000);
    await db3.query('DELETE FROM coaching_actions WHERE done_by = $1', [by]);
    const teams = (await db3.query(`
      SELECT DISTINCT COALESCE(NULLIF(au.department, ''), NULLIF(u.department, '')) AS d
        FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
       WHERE u.email LIKE '%@acmecorp.example' AND COALESCE(NULLIF(au.department, ''), NULLIF(u.department, '')) IS NOT NULL`)).rows.map((r) => r.d);
    // [surface, key, wording, figure, team then, organisation then, days ago, note]
    const ACTIONS = [
      ['cowork', 'learn_from', 'Ask the people who get the most out of it to show the team how they work.', 'deep_share', 0.5, 0.58, 35, 'Two lunchtime sessions, run by the team.'],
      ['cowork', 'produced_nothing', 'Take one of those sessions and ask for the finished document, not the answer to a question.', 'produced_nothing_share', 0.9, null, 5, null],
      ['cowork', 'hardly_used', 'Ask the people who have hardly used it what stopped them, before anything else.', 'hardly_used_share', 0.55, 0.3, 40, 'Most had not been shown where to start.'],
      ['code', 'learn_from', 'Ask the people who hand over the most to show the team how they work.', 'deep_share', 0.38, 0.42, 35, 'Paired sessions on two real tickets.'],
      ['code', 'new_starters', 'Pair the new starters with someone who hands over well, in their first weeks.', 'deep_share', 0.4, 0.43, 5, null],
      ['code', 'hardly_used', 'Ask the people who have hardly used it what stopped them, before anything else.', 'hardly_used_share', 0.5, 0.25, 40, 'Set-up was the blocker; now fixed.'],
    ];
    let n = 0;
    for (const d of teams) {
      for (const [surface, key, text, metric, baseline, orgBaseline, daysAgo, note] of ACTIONS) {
        await db3.query(
          `INSERT INTO coaching_actions (surface, department, action_key, action_text, metric, baseline, org_baseline, note, done_by, done_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [surface, d, key, text, metric, baseline, orgBaseline, note, by, nowS3 - daysAgo * 86400]);
        n++;
      }
    }
    await db3.end();
    console.log(`${n} actions across ${teams.length} teams.`);
  }

  // The Hub sets a person's last-seen time whenever their activity arrives.
  // The sample writes activity straight to the tables, so set it here from
  // each person's latest activity; otherwise the dashboard's Users column
  // counts fewer active people than its product columns.
  console.log('\nSetting when each person was last seen...');
  {
    const db2 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db2.connect();
    const seen = await db2.query(`
      UPDATE users u SET last_seen_at = GREATEST(COALESCE(u.last_seen_at, 0), m.last)
      FROM (SELECT user_id, MAX(occurred_at) AS last FROM cowork_messages WHERE user_id IS NOT NULL GROUP BY user_id) m
      WHERE m.user_id = u.id`);
    // Use case matches and weekly figures, made to agree with this sample's
    // sessions. The bundled matches came from another installation: most name
    // sessions this sample doesn't have (its session ids change on each load),
    // and the rest sit in a week other than the one their session happened in,
    // so their time could not be measured. A match to a session the sample has
    // is filed, as the Hub does, under the Monday-UTC week of that session's
    // first prompt. A match to a session it doesn't have is dropped: moving it
    // onto another of the person's sessions would claim work that session did
    // not do. Claude sessions are then matched the way 11-chatgpt-codex.ts
    // matches ChatGPT and Codex: a session matches a use case of the person's
    // department (or one for everyone) when one of its prompts carries one of
    // the use case's clue words (4 letters or more) and the use case covers
    // that kind of work (Claude Code as Code, everything else as Work). With a
    // Claude API key the Hub's session judge reads the work itself.
    // Each week's people, sessions, prompts and last-seen time are then
    // counted from its matches (a week left with none reads zero), and time and
    // tool figures are worked out from the matched sessions below
    // (lib/usecases/impact-rollup.ts).
    await db2.query('BEGIN');
    const ucBefore = Number((await db2.query(`SELECT COUNT(*) AS n FROM use_case_week_matches WHERE session_id <> ''`)).rows[0].n);
    await db2.query(`
      CREATE TEMP TABLE uc_realigned ON COMMIT DROP AS
      WITH msg AS (
        SELECT session_id, MIN(occurred_at) AS first_at, MIN(user_id) AS user_id
        FROM cowork_messages WHERE session_id IS NOT NULL AND user_id IS NOT NULL GROUP BY session_id)
      SELECT DISTINCT m.use_case_id,
             (floor((s.first_at - 345600) / 604800.0) * 604800 + 345600)::bigint AS week_start,
             s.user_id, m.session_id, 'kept' AS how
      FROM use_case_week_matches m JOIN msg s ON s.session_id = m.session_id
      WHERE m.session_id <> ''`);
    await db2.query(`
      INSERT INTO uc_realigned (use_case_id, week_start, user_id, session_id, how)
      WITH uc AS (
        SELECT id,
               (CASE WHEN departments IS NULL OR departments = '' THEN '[]' ELSE departments END)::jsonb AS deps,
               (CASE WHEN surfaces IS NULL OR surfaces = '' THEN '[]' ELSE surfaces END)::jsonb AS surf,
               (CASE WHEN keywords IS NULL OR keywords = '' THEN '[]' ELSE keywords END)::jsonb AS kw
        FROM use_cases WHERE status <> 'archived'),
      words AS (
        SELECT uc.id, lower(k) AS k FROM uc, jsonb_array_elements_text(uc.kw) AS k WHERE length(k) >= 4),
      sess AS (
        SELECT m.session_id, m.user_id,
               CASE WHEN bool_or(m.surface = 'code') THEN 'code' ELSE 'cowork' END AS surface,
               MIN(m.occurred_at) AS first_at,
               string_agg(lower(COALESCE(m.content_full, m.content_preview, '')), ' ') AS text,
               MAX(COALESCE(NULLIF(TRIM(u.department), ''), NULLIF(TRIM(au.department), ''))) AS dept
        FROM cowork_messages m
        LEFT JOIN users u ON u.id = m.user_id
        LEFT JOIN admin_users au ON au.linked_cowork_user_id = m.user_id
        WHERE (m.source IS NULL OR m.source NOT IN ('chatgpt_chat', 'chatgpt_work', 'codex'))
          AND m.user_id IS NOT NULL AND m.session_id IS NOT NULL
          AND m.message_type IN ('cowork_user_message', 'code_user_message')
        GROUP BY m.session_id, m.user_id)
      SELECT DISTINCT uc.id,
             (floor((s.first_at - 345600) / 604800.0) * 604800 + 345600)::bigint,
             s.user_id, s.session_id, 'keyword'
      FROM uc JOIN words w ON w.id = uc.id
      JOIN sess s ON position(w.k IN s.text) > 0
      WHERE (jsonb_array_length(uc.deps) = 0 OR (s.dept IS NOT NULL AND uc.deps ? s.dept))
        AND (jsonb_array_length(uc.surf) = 0 OR uc.surf ? s.surface)
        AND NOT EXISTS (SELECT 1 FROM uc_realigned r WHERE r.use_case_id = uc.id AND r.session_id = s.session_id)`);
    const ucCounts = (await db2.query(`SELECT how, COUNT(*) AS n FROM uc_realigned GROUP BY how`)).rows;
    const ucKept = Number(ucCounts.find((r) => r.how === 'kept')?.n ?? 0);
    const ucWords = Number(ucCounts.find((r) => r.how === 'keyword')?.n ?? 0);
    console.log(`${ucKept} use case matches kept, ${Math.max(0, ucBefore - ucKept)} dropped because their session is not in this sample, ${ucWords} Claude sessions matched by their use case's clue words.`);
    await db2.query(`DELETE FROM use_case_week_matches WHERE session_id <> ''`);
    await db2.query(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id)
      SELECT use_case_id, week_start, user_id, session_id FROM uc_realigned ON CONFLICT DO NOTHING`);
    await db2.query(`INSERT INTO use_case_activation_weeks (use_case_id, week_start)
      SELECT DISTINCT use_case_id, week_start FROM uc_realigned ON CONFLICT DO NOTHING`);
    await db2.query(`
      WITH s AS (
        SELECT session_id,
               COUNT(*) FILTER (WHERE message_type IN ('cowork_user_message', 'code_user_message')) AS prompts,
               MAX(occurred_at) AS last_at
        FROM cowork_messages WHERE session_id IS NOT NULL GROUP BY session_id),
      j AS (
        SELECT m.use_case_id, m.week_start, COUNT(DISTINCT m.user_id) AS users,
               COUNT(DISTINCT m.session_id) FILTER (WHERE m.session_id <> '') AS sessions,
               COALESCE(SUM(s.prompts), 0) AS prompts, MAX(s.last_at) AS last_seen
        FROM use_case_week_matches m LEFT JOIN s ON s.session_id = m.session_id
        GROUP BY 1, 2)
      UPDATE use_case_activation_weeks w
      SET distinct_users = COALESCE(j.users, 0), session_count = COALESCE(j.sessions, 0),
          matched_messages = COALESCE(j.prompts, 0), last_seen_at = j.last_seen
      FROM use_case_activation_weeks w2
      LEFT JOIN j ON j.use_case_id = w2.use_case_id AND j.week_start = w2.week_start
      WHERE w.use_case_id = w2.use_case_id AND w.week_start = w2.week_start`);
    await db2.query('COMMIT');
    await db2.end();
    console.log(`${seen.rowCount} people.`);
  }
  console.log('\nRecounting use case time from the matched sessions...');
  run('npx', ['tsx', '-e', [
    "import('./lib/usecases/impact-rollup.ts').then(async (m) => {",
    '  const recompute = m.recomputeWeekImpact || m.default.recomputeWeekImpact;',
    "  const pg = (await import('pg')).default;",
    "  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;",
    '  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });',
    '  await db.connect();',
    '  const weeks = (await db.query(`SELECT use_case_id, week_start FROM use_case_activation_weeks`)).rows;',
    '  await db.end();',
    '  for (const w of weeks) await recompute(w.use_case_id, Number(w.week_start));',
    "  console.log(weeks.length + ' weeks.');",
    '  process.exit(0);',
    '}).catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n')]);

  // Briefings are written from the activity they describe. This load replaced
  // that activity, so the organisation's, its teams' and its people's briefings
  // go, and the Hub writes new ones from the new rows.
  console.log('\nRemoving briefings written from the earlier sample...');
  try {
    const db6 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db6.connect();
    const gone = await db6.query(`
      WITH people AS (
        SELECT DISTINCT user_id AS id FROM cowork_messages WHERE user_id IS NOT NULL AND (id LIKE ANY($1::text[]) OR session_id LIKE ANY($1::text[]))
        UNION SELECT DISTINCT user_id FROM code_session_stats WHERE user_id IS NOT NULL AND session_id LIKE ANY($1::text[])),
      teams AS (
        SELECT NULLIF(TRIM(u.department), '') AS d FROM users u JOIN people p ON p.id = u.id
        UNION SELECT NULLIF(TRIM(au.department), '') FROM admin_users au JOIN people p ON p.id = au.linked_cowork_user_id)
      DELETE FROM pulse_briefings
       WHERE scope_type = 'organisation'
          OR (scope_type = 'function' AND scope_id IN (SELECT d FROM teams WHERE d IS NOT NULL))
          OR (scope_type = 'user' AND scope_id IN (SELECT id FROM people))`, [SAMPLE_LIKE]);
    await db6.end();
    console.log(`${gone.rowCount} briefings removed.`);
  } catch (e) { console.error(`Removing briefings failed (${e.message}); continuing.`); }

  // Alerts an earlier load left behind: the same alert raised twice for one
  // prompt (keep the first), and alerts on ChatGPT or Codex prompts this
  // sample no longer has, whose "View in Audit Log" link would find nothing.
  try {
    const db7 = new Client({ connectionString: process.env.DATABASE_URL, ssl });
    await db7.connect();
    const twice = await db7.query(`
      DELETE FROM alerts a USING alerts b
       WHERE a.raw_evidence->>'message_id' IS NOT NULL
         AND a.raw_evidence->>'message_id' = b.raw_evidence->>'message_id'
         AND a.alert_type = b.alert_type AND a.title = b.title AND a.id > b.id`);
    const orphaned = await db7.query(`
      DELETE FROM alerts a
       WHERE (a.raw_evidence->>'message_id' LIKE 'chatgpt:%' OR a.raw_evidence->>'message_id' LIKE 'codex:%')
         AND NOT EXISTS (SELECT 1 FROM cowork_messages m WHERE m.id = a.raw_evidence->>'message_id')`);
    await db7.end();
    console.log(`${twice.rowCount} repeated and ${orphaned.rowCount} orphaned alerts removed.`);
  } catch (e) { console.error(`Tidying alerts failed (${e.message}); continuing.`); }

  console.log('\nSample data loaded. Pages fill in within a few minutes, once the Hub has run its scheduled jobs.');
})().catch((e) => { console.error(e); process.exit(1); });

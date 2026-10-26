// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Loads sample data: a fictional organisation and its activity, so every
// page of Command Centre has something to show.
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
  ['ff11-', '09-human-time.cjs'],
  ['ff13-', '10-conversations.cjs'],
];

// The feature switches the sample data shows (all but single sign-on, which
// needs an identity provider). Its demo figures for FinOps and Dev Framework Alignment
// also need CCC_FINOPS_ALLOW_MOCK and CCC_DX_ALLOW_MOCK on the Hub.
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
  ['finance_enterprise_mock', 'true'],
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
// their last-run times makes the Hub run them again on its next cycle.
const RERUN_JOBS = ['cowork_session_agg_last_run', 'pulse_aggregator_last_run',
  'pulse_aggregator_daily_last_run', 'code_aggregator_last_run'];

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
  // not carry a sample prefix also counts as real.
  const markers = await db.query(
    "SELECT key FROM config WHERE key IN ('setup_first_code_at', 'setup_first_cowork_at', 'compliance_last_sync_at')");
  const samplePatterns = STEPS.map(([prefix]) => `${prefix}%`);
  const notSample = samplePatterns.map((_, i) => `id NOT LIKE $${i + 1}`).join(' AND ');
  let realMessages = 0;
  for (const table of ['cowork_messages', 'chat_messages']) {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${notSample}`, samplePatterns);
    realMessages += r.rows[0].n;
  }
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

  for (const [prefix, script] of STEPS) {
    // Command Centre grades sample messages like any others. Clear those
    // grades first, or a re-run cannot replace the messages they belong to.
    await db.query('DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1', [prefix + '%']);
    await db.query('DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1', [prefix + '%']);
    console.log(`\nRunning ${script}...`);
    try { run('node', [path.join(__dirname, script)]); }
    catch { console.error(`${script} failed; continuing with the rest.`); }
  }

  // The sample S&C Board entries, use cases (with their weekly figures and
  // matches) and department process suggestions. Nothing in them is tied to
  // anyone outside the fictional organisation.
  console.log('\nAdding the sample S&C Board, use cases and suggestions...');
  const extra = require('./demo-hub-board-and-use-cases.json');
  const asParam = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  const insertRows = async (table, rows) => {
    let n = 0;
    for (const r of rows) {
      const cols = Object.keys(r);
      const res = await db.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => asParam(r[c])));
      n += res.rowCount;
    }
    return n;
  };
  const boardN = await insertRows('skill_library_entries', extra.library);
  const ucN = await insertRows('use_cases', extra.use_cases);
  const weekN = await insertRows('use_case_activation_weeks', extra.weeks);
  const sugN = await insertRows('use_case_suggestions', extra.suggestions);
  const matches = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'demo-hub-use-case-matches.json.gz'))).toString('utf8'));
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
  console.log('\nSample data loaded. Pages fill in within a few minutes, once the Hub has run its scheduled jobs.');
})().catch((e) => { console.error(e); process.exit(1); });

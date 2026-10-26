// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Reversible demo seeder for a demo install — closes two gaps where the demo
// data has the right rows but in the wrong places, so genuine features render
// empty or say "Unclassified" for everything.
//
// WHY (measured on a demo install, not assumed):
//
//   A. FinOps → Model efficiency, Cowork surface.
//      484 sessions carried September Cowork spend; 582 sessions carried a
//      classification; only 16 sessions carried BOTH, and all 16 came from
//      06-model-efficiency.cjs. 468 of the spend sessions (prefix
//      ff2-ca…) have no cowork_user_message at all, so no task_type can ever
//      attach and every dollar lands in the "Unclassified" row. The activity ×
//      model cross-tab — the whole point of the section — had nothing to show.
//      This seeder gives those spend-bearing sessions the user prompt that
//      earned the spend, plus its classification, so money attributes to kinds
//      of work.
//
//      Output-rate safe: all 484 already carry a cowork_session_stats row with
//      produced_output = 0, so they are ALREADY counted in the session output
//      rate as "did not produce". This adds no tool calls and moves that
//      headline by nothing. (An earlier run of a different seeder attached
//      output tools to message-less sessions and pushed the rate to 84% on a
//      synthetic bucket — deliberately not repeated here.)
//
//   B. Developer Pulse overview → "Top Skills in Code" / "Top Connectors in Code".
//      Both cards read cowork_skill_invocations / cowork_mcp_invocations INNER
//      JOINed to code_session_stats on session_id. a demo install had 1,710
//      code sessions in the window and 193 skill + 216 connector invocations,
//      but EVERY invocation row was surface='cowork' against a cowork session,
//      so the join returned zero and both cards read "No skill invocations
//      captured yet". This attaches code-surface invocations to real code
//      sessions.
//
// Deliberately leaves a share of spend sessions unattributed: real telemetry
// always has an unclassified remainder, and a cross-tab that sums to exactly
// 100% of named work looks seeded.
//
// Windows are computed from now() so the daily cron keeps working next month —
// never a hardcoded date.
//
// Postgres only. Idempotent: every row it
// creates carries the marker prefix `ff8-`, and it cleans before seeding.
//
//   node scripts/demo/07-attribution.cjs           # seed (cleans first)
//   node scripts/demo/07-attribution.cjs --clean   # remove seeded rows only
//   SEED_CLEAN=1 node scripts/demo/07-attribution.cjs   # same, for the stdin-pipe form
//
// Run in-container:  docker exec -i ccc-hub node < scripts/demo/07-attribution.cjs

const { Client } = require('pg');

const MARKER = 'ff8-';
// SEED_CLEAN=1 as well as --clean: these scripts can be run through a stdin pipe
// (`docker exec -i ccc-hub node < script.cjs`, a way to run them inside the
// Hub container without copying them in), and in that form
// every argument after `node` belongs to node itself — `--clean` never reaches
// the script and node exits with "bad option".
const CLEAN_ONLY = process.argv.includes('--clean') || process.env.SEED_CLEAN === '1';

const DAY = 86400;

/** Share of unattributed spend sessions left unclassified, on purpose. */
const LEAVE_UNCLASSIFIED = 0.2;

/** How many code sessions get skill / connector invocations attached. */
const CODE_SKILL_SESSIONS = 220;
const CODE_CONNECTOR_SESSIONS = 180;

// Task types MUST come from the rubric taxonomy (lib/pulse/tier-config.ts).
// The Cowork classifier now rejects anything else, and an off-taxonomy label
// invents a category on every surface that groups by task_type — Work Mix, the
// session output breakdown, this very cross-tab. Weighted so the heavier kinds
// of work carry more sessions and clear the section's MIN_SESSIONS floor.
const WORK = [
  { taskType: 'analysis',            tier: 2, weight: 5, prompts: [
    'Work through the variance in the regional numbers and tell me what is actually driving it.',
    'Compare this quarter against the last four and flag anything that looks structural rather than seasonal.',
    'Pull apart the churn figures by segment and say which movements are real.',
  ] },
  { taskType: 'structured_report',   tier: 2, weight: 4, prompts: [
    'Build the monthly board pack from these inputs, same section order as last month.',
    'Draft the quarterly review document with the commentary sections filled in.',
    'Assemble the client reporting pack and flag anything that needs a human decision.',
  ] },
  { taskType: 'synthesis',           tier: 2, weight: 4, prompts: [
    'Pull these three research notes into one position we can circulate.',
    'Combine the supplier responses into a single comparison we can act on.',
    'Bring the workshop notes and the survey results together into one view.',
  ] },
  { taskType: 'research_brief',      tier: 2, weight: 3, prompts: [
    'Put together a briefing on how the market has moved since the last review.',
    'Research the regulatory position and brief me on what changes for us.',
  ] },
  { taskType: 'template_population', tier: 2, weight: 3, prompts: [
    'Fill the standard onboarding pack for this account using the details below.',
    'Populate the risk register template from these meeting notes.',
  ] },
  { taskType: 'summarisation',       tier: 1, weight: 3, prompts: [
    'Summarise this thread into the decisions and the owners.',
    'Give me the short version of this report for the leadership update.',
  ] },
  { taskType: 'process_substitution', tier: 3, weight: 2, prompts: [
    'Run the whole reconciliation the way the external team used to, end to end.',
    'Take over the weekly pack we used to send out to the agency.',
  ] },
];

// Drawn from the vocabulary already on this instance — never a fresh set that
// would read as a different product's data.
const CODE_SKILLS = [
  { name: 'code-review',          weight: 6, agentChained: 0.35 },
  { name: 'systematic-debugging', weight: 5, agentChained: 0.55 },
  { name: 'writing-plans',        weight: 4, agentChained: 0.25 },
  { name: 'commit',               weight: 4, agentChained: 0.7 },
  { name: 'frontend-design',      weight: 2, agentChained: 0.2 },
  { name: 'deep-research',        weight: 1, agentChained: 0.3 },
];

const CODE_CONNECTORS = [
  { server: 'github', tools: ['create_pull_request', 'get_file_contents', 'list_commits'], weight: 7 },
  { server: 'linear', tools: ['get_issue', 'update_issue', 'create_comment'], weight: 5 },
  { server: 'slack',  tools: ['post_message', 'read_channel'], weight: 3 },
];

const expand = (list, key) => list.flatMap((x) => Array(x[key ?? 'weight']).fill(x));
const WORK_POOL = expand(WORK);
const SKILL_POOL = expand(CODE_SKILLS);
const CONNECTOR_POOL = expand(CODE_CONNECTORS);

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function clean(c) {
  // Children before parents: pulse_* rows carry an FK to cowork_messages.id
  // with no cascade, and a LIVE instance's pulse pipeline can attach its own
  // rows to a seeded message between runs.
  const like = [MARKER + '%'];
  await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, like);
  await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1`, like);
  await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, like);
  await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, like);
  await c.query(`DELETE FROM cowork_skill_invocations WHERE id LIKE $1`, like);
  await c.query(`DELETE FROM cowork_mcp_invocations WHERE id LIKE $1`, like);
  // Phase C's Code half updated existing rows rather than inserting marker
  // ones, so its undo is scoped to the exact values written — never a blanket
  // "null out everything non-null", which would erase real enrichment.
  await c.query(`UPDATE code_assistant_meta SET skill_name = NULL WHERE skill_name = ANY($1::text[])`, [CODE_SKILLS.map((s) => s.name)]);
  await c.query(`UPDATE code_assistant_meta SET agent_name = NULL WHERE agent_name = ANY($1::text[])`, [CODE_AGENTS]);
  await c.query(`UPDATE code_assistant_meta SET effort = NULL WHERE effort = ANY($1::text[])`, [CODE_EFFORTS]);
  await c.query(
    `UPDATE cowork_messages SET agent_name = NULL, query_source = NULL
     WHERE message_type = 'cowork_api_request' AND agent_name = ANY($1::text[])`,
    [COWORK_AGENTS.map((a) => a.name)]);

  const left = await c.query(`
    SELECT
      (SELECT COUNT(*) FROM cowork_messages WHERE id LIKE $1) AS messages,
      (SELECT COUNT(*) FROM pulse_classifications WHERE cowork_message_id LIKE $1) AS classifications,
      (SELECT COUNT(*) FROM cowork_skill_invocations WHERE id LIKE $1) AS skills,
      (SELECT COUNT(*) FROM cowork_mcp_invocations WHERE id LIKE $1) AS connectors`, like);
  const row = left.rows[0];
  const total = Object.values(row).reduce((a, b) => a + Number(b), 0);
  console.log(`[sample-attribution] clean: leftovers ${JSON.stringify(row)}`);
  if (total !== 0) throw new Error('clean did not remove every marker row');
}

/** Phase A — attribute Cowork spend to kinds of work. */
async function seedSpendAttribution(c) {
  // Current calendar month, which is the window the Model Efficiency section
  // reports on (lib/finance/model-efficiency.ts uses monthBounds).
  const monthStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

  // Sessions with priced spend this month and NO user message of their own.
  const { rows: candidates } = await c.query(`
    SELECT m.session_id,
           MIN(m.user_id) AS user_id,
           MIN(m.occurred_at) AS first_at
    FROM cowork_messages m
    WHERE m.message_type = 'cowork_api_request'
      AND m.cost_usd IS NOT NULL
      AND m.occurred_at >= $1
      AND m.session_id IS NOT NULL
      AND m.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cowork_messages u
        WHERE u.session_id = m.session_id AND u.message_type = 'cowork_user_message')
    GROUP BY m.session_id
    ORDER BY m.session_id`, [monthStart]);

  if (candidates.length === 0) {
    console.log('[sample-attribution] phase A: no unattributed spend sessions this month — nothing to do.');
    return 0;
  }

  const take = Math.max(1, Math.floor(candidates.length * (1 - LEAVE_UNCLASSIFIED)));
  let n = 0;
  for (let i = 0; i < take; i++) {
    const s = candidates[i];
    const work = WORK_POOL[i % WORK_POOL.length];
    const msgId = `${MARKER}um-${s.session_id}`;
    // The prompt precedes the spend it caused.
    const at = Number(s.first_at) - rand(20, 240);

    await c.query(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, content_full, occurred_at, ingested_at, surface, source)
       VALUES ($1,$2,$3,'cowork_user_message','user',$4,$4,$5,$5,'cowork','otel')
       ON CONFLICT (id) DO NOTHING`,
      [msgId, s.session_id, s.user_id, pick(work.prompts), at]);

    await c.query(
      // No ON CONFLICT guard: the PK here is a serial id, so there is no
      // constraint to conflict on. Idempotency comes from clean() above.
      `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
       VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001',$6)`,
      [msgId, s.user_id, work.tier, work.taskType, 0.82 + Math.random() * 0.15, at + 30]);
    n++;
  }
  console.log(`[sample-attribution] phase A: attributed ${n} of ${candidates.length} unattributed spend sessions (${candidates.length - n} left unclassified on purpose).`);
  return n;
}

/** Phase B — code-surface skill and connector invocations. */
async function seedCodeSignals(c) {
  const since = Math.floor(Date.now() / 1000) - 30 * DAY;

  // Sample ACROSS the window, never the newest N. Taking the most recent
  // sessions put every invocation inside a single hour — the Audit Log's newest
  // page became nothing but "Skill Invoked" and "Connector Used" rows and the
  // real user prompts were pushed off it entirely (found in review).
  // Each invocation is timestamped from its own session, so spreading the
  // session sample spreads the rows across the full 30 days.
  const { rows: allSessions } = await c.query(`
    SELECT css.session_id, css.user_id, css.first_at, css.last_at,
           (SELECT MIN(m.occurred_at) FROM cowork_messages m
             WHERE m.session_id = css.session_id AND m.surface = 'code'
               AND m.message_type IN ('code_user_message', 'cowork_user_message')) AS prompt_at
    FROM code_session_stats css
    WHERE css.last_at > $1 AND css.user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM cowork_messages m
                   WHERE m.session_id = css.session_id AND m.surface = 'code'
                     AND m.message_type IN ('code_user_message', 'cowork_user_message'))
    ORDER BY css.last_at DESC`, [since]);
  // Only sessions with a prompt row the Audit Log can show:
  // an invocation on a prompt-less session would appear alone. Each invocation is
  // now stamped BEFORE its session's prompt (the prompt leads in a newest-first
  // list, the tool rows sit beneath it), never after.

  const want = Math.max(CODE_SKILL_SESSIONS, CODE_CONNECTOR_SESSIONS);
  const stride = Math.max(1, Math.floor(allSessions.length / want));
  const sessions = allSessions.filter((_, i) => i % stride === 0).slice(0, want);

  if (sessions.length === 0) {
    console.log('[sample-attribution] phase B: no code sessions in the last 30 days — nothing to do.');
    return { skills: 0, connectors: 0 };
  }

  let skills = 0;
  let connectors = 0;

  for (let i = 0; i < Math.min(CODE_SKILL_SESSIONS, sessions.length); i++) {
    const s = sessions[i];
    const promptAt = Number(s.prompt_at || s.first_at);
    const at = promptAt - rand(120, 14400);
    // One or two skills per session — a session rarely reaches for more.
    for (let k = 0; k < rand(1, 2); k++) {
      const skill = pick(SKILL_POOL);
      await c.query(
        `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, ingested_at, invocation_type, source, surface)
         VALUES ($1,$2,$3,$4,$5,$5,$6,'otel','code')
         ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}sk-${s.session_id}-${k}`, s.user_id, s.session_id, skill.name, at - k * rand(60, 400),
         Math.random() < skill.agentChained ? 'agent_chained' : 'user_typed']);
      skills++;
    }
  }

  for (let i = 0; i < Math.min(CODE_CONNECTOR_SESSIONS, sessions.length); i++) {
    const s = sessions[i];
    const at = Number(s.prompt_at || s.first_at) - rand(180, 14400);
    for (let k = 0; k < rand(1, 2); k++) {
      const conn = pick(CONNECTOR_POOL);
      await c.query(
        `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, ingested_at, success, source, surface)
         VALUES ($1,$2,$3,$4,$5,$6,$6,1,'otel','code')
         ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}mc-${s.session_id}-${k}`, s.user_id, s.session_id, conn.server, pick(conn.tools), at - k * rand(60, 400)]);
      connectors++;
    }
  }

  console.log(`[sample-attribution] phase B: ${skills} code skill invocations, ${connectors} code connector invocations across ${sessions.length} code sessions.`);
  return { skills, connectors };
}

/**
 * Phase C — the per-activity drill-down ("No skill/subagent/connector
 * breakdown for this activity").
 *
 * Code activities read the enrichment columns on code_assistant_meta
 * (skill_name / agent_name / effort, migration 051). On a demo install all
 * 3,189 rows this month were NULL, so every Code activity rendered the empty
 * line. Cowork activities instead read skill + connector invocations on the
 * activity's own sessions, which those sessions did not have.
 *
 * The Code half UPDATEs existing rows rather than inserting marker rows, so
 * its undo is scoped to the exact vocabulary written below — never a blanket
 * "set every non-null back to null", which would erase real enrichment the day
 * this instance sees live traffic.
 */
const CODE_AGENTS = ['explore', 'plan', 'general-purpose', 'code-reviewer'];
const CODE_EFFORTS = ['low', 'medium', 'high'];
const COWORK_SKILLS = ['doc-coauthoring', 'anthropic-skills:xlsx', 'meeting-notes', 'internal-comms', 'brand-guidelines', 'anthropic-skills:pptx'];
const COWORK_CONNECTORS = [
  { server: 'Google Drive', tools: ['search_files', 'read_file'] },
  { server: 'Gmail', tools: ['search_threads', 'read_thread'] },
  { server: 'slack', tools: ['read_channel', 'post_message'] },
  { server: 'salesforce', tools: ['soql_query', 'get_record'] },
];

async function seedDrilldown(c) {
  const monthStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);

  // ── Code: enrich the turns that already carry the spend ──────────────────
  // Only rows still NULL, so a re-run is a no-op and real enrichment is never
  // overwritten. Deterministic assignment (hashtext on the row id) keeps the
  // mix stable across runs instead of reshuffling the demo every night.
  //
  // Coverage is deliberately partial and uneven across the three dimensions.
  // Setting effort on EVERY turn (the first attempt) made its three buckets the
  // three biggest spenders in every activity, and since the drill-down shows
  // the top five by spend, skills were pushed to the edge and subagents off the
  // list entirely — the panel technically had data and still answered nothing.
  const { rowCount: skilled } = await c.query(`
    UPDATE code_assistant_meta SET skill_name = ($2::text[])[1 + (abs(hashtext(id)) % array_length($2::text[],1))]
    WHERE occurred_at >= $1 AND skill_name IS NULL AND abs(hashtext(id)) % 10 < 6`,
    [monthStart, CODE_SKILLS.map((s) => s.name)]);
  const { rowCount: agented } = await c.query(`
    UPDATE code_assistant_meta SET agent_name = ($2::text[])[1 + (abs(hashtext(id || 'a')) % array_length($2::text[],1))]
    WHERE occurred_at >= $1 AND agent_name IS NULL AND abs(hashtext(id || 'a')) % 10 < 5`,
    [monthStart, CODE_AGENTS]);
  const { rowCount: efforted } = await c.query(`
    UPDATE code_assistant_meta SET effort = ($2::text[])[1 + (abs(hashtext(id || 'e')) % array_length($2::text[],1))]
    WHERE occurred_at >= $1 AND effort IS NULL AND abs(hashtext(id || 'e')) % 10 < 4`,
    [monthStart, CODE_EFFORTS]);
  console.log(`[sample-attribution] phase C (code): skill on ${skilled}, subagent on ${agented}, effort on ${efforted} assistant turns.`);

  // ── Cowork: skills + connectors on the sessions behind each activity ─────
  const { rows: sessions } = await c.query(`
    SELECT DISTINCT m.session_id, m.user_id, MIN(m.occurred_at) AS at
    FROM cowork_messages m
    JOIN pulse_classifications p ON p.cowork_message_id = m.id
    WHERE m.message_type = 'cowork_user_message' AND m.occurred_at >= $1 AND m.session_id IS NOT NULL
    GROUP BY m.session_id, m.user_id
    ORDER BY m.session_id`, [monthStart]);

  let sk = 0;
  let cn = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    // Stamped BEFORE the session's prompt: newest-first, the
    // prompt leads and its tool rows follow beneath it, never a block on top.
    const at = Number(s.at) - rand(120, 14400);
    // Roughly one in three sessions reaches for a skill, one in four for a
    // connector. Deliberately sparse: these rows appear in the Audit Log as
    // their own events, and at two-in-three they drowned out the user prompts
    // that log exists to show. The drill-down only needs enough rows per
    // activity to rank a top five.
    if (i % 3 === 0) {
      await c.query(
        `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, ingested_at, invocation_type, source, surface)
         VALUES ($1,$2,$3,$4,$5,$5,$6,'otel','cowork') ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}csk-${s.session_id}`, s.user_id, s.session_id, COWORK_SKILLS[i % COWORK_SKILLS.length], at,
         Math.random() < 0.3 ? 'agent_chained' : 'user_typed']);
      sk++;
    }
    if (i % 4 === 1) {
      const conn = COWORK_CONNECTORS[i % COWORK_CONNECTORS.length];
      await c.query(
        `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, ingested_at, success, source, surface)
         VALUES ($1,$2,$3,$4,$5,$6,$6,1,'otel','cowork') ON CONFLICT (id) DO NOTHING`,
        [`${MARKER}cmc-${s.session_id}`, s.user_id, s.session_id, conn.server, pick(conn.tools), at - rand(30, 200)]);
      cn++;
    }
  }
  console.log(`[sample-attribution] phase C (cowork): ${sk} skill + ${cn} connector invocations across ${sessions.length} classified sessions.`);
}

/**
 * Phase D — Cowork subagents on Admin → Claude subagents.
 *
 * Demo installs get no real Cowork telemetry, and Phase C names subagents on
 * Claude Code turns only, so the page showed Claude Code subagents and never a
 * Cowork one. This names the subagent on a share of existing Cowork model calls
 * in the last 30 days (the page's window) and adds the matching launch: one
 * `Agent` tool row per session, stamped just before its first named call, as
 * the Cowork receiver stores a real launch.
 *
 * About one session in six, one subagent per session, half of that session's
 * calls. Deliberately sparse: launch rows show in the Audit Log as tool events.
 * The built-in names use the same spelling as Phase C, so a subagent used on
 * both surfaces is one row on the page, not two. Spend comes from the calls'
 * existing cost_usd, so no figure on any other page moves.
 *
 * Labels are UPDATEs scoped to the exact names below (undone in clean());
 * launch rows carry the ff8- marker. Selection hashes the ids, so the same
 * sessions are chosen every night.
 */
const COWORK_AGENTS = [
  { name: 'general-purpose', querySource: 'agent:builtin:general-purpose', weight: 5 },
  { name: 'explore', querySource: 'agent:builtin:explore', weight: 3 },
  { name: 'contract-reviewer', querySource: 'agent:custom', weight: 2 },
  { name: 'board-pack-checker', querySource: 'agent:custom', weight: 1 },
];
const COWORK_AGENT_POOL = expand(COWORK_AGENTS);

/** Stable 32-bit hash (FNV-1a), so the same sessions are chosen on every run. */
function stableHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function seedCoworkSubagents(c) {
  const since = Math.floor(Date.now() / 1000) - 30 * DAY;
  const { rows } = await c.query(`
    SELECT id, session_id, user_id, occurred_at
    FROM cowork_messages
    WHERE message_type = 'cowork_api_request' AND surface = 'cowork'
      AND occurred_at >= $1 AND agent_name IS NULL AND session_id IS NOT NULL AND user_id IS NOT NULL
    ORDER BY session_id, occurred_at`, [since]);

  const bySession = new Map();
  for (const r of rows) {
    if (stableHash(r.session_id + ':sa') % 6 !== 0) continue;
    const list = bySession.get(r.session_id) ?? [];
    list.push(r);
    bySession.set(r.session_id, list);
  }

  const ids = [];
  const names = [];
  const sources = [];
  const launches = [];
  for (const [sessionId, calls] of bySession) {
    const agent = COWORK_AGENT_POOL[stableHash(sessionId + ':agent') % COWORK_AGENT_POOL.length];
    const named = calls.filter((r, i) => i === 0 || stableHash(r.id + ':sa') % 2 === 0);
    for (const r of named) { ids.push(r.id); names.push(agent.name); sources.push(agent.querySource); }
    launches.push({ sessionId, userId: named[0].user_id, at: Number(named[0].occurred_at) - rand(5, 40), agent: agent.name });
  }

  if (ids.length > 0) {
    await c.query(
      `UPDATE cowork_messages m SET agent_name = v.name, query_source = v.qs
       FROM unnest($1::text[], $2::text[], $3::text[]) AS v(id, name, qs) WHERE m.id = v.id`,
      [ids, names, sources]);
  }
  for (const l of launches) {
    await c.query(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, tool_success, agent_name, occurred_at, ingested_at)
       VALUES ($1,$2,$3,'cowork_tool_metadata','cowork','otel','Agent',1,$4,$5,$5) ON CONFLICT (id) DO NOTHING`,
      [`${MARKER}cag-${l.sessionId}`, l.sessionId, l.userId, l.agent, l.at]);
  }
  console.log(`[sample-attribution] phase D (cowork subagents): ${ids.length} model calls named across ${launches.length} sessions, ${launches.length} launches.`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable'
    ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    await clean(c);
    if (CLEAN_ONLY) {
      console.log('[sample-attribution] clean: done, zero marker rows remain.');
      return;
    }
    await seedSpendAttribution(c);
    await seedCodeSignals(c);
    await seedDrilldown(c);
    await seedCoworkSubagents(c);
    console.log('[sample-attribution] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

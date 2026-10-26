// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample data for the "Turn this into a skill" feature, run with the other
// sample scripts. It uses plain `pg` because the hub container ships no tsx.
//
// Four confirmed workflows with authored prompt corpora, shaped for a
// viewer's eyes: Acme Corp emails (the demo org), the demo's own departments
// (Finance / HR / Sales — no "Operations", which is not one of the nine), and
// every session carries a priced `cowork_api_request` row so the Audit Log's
// Session Stats (cost / tokens / model) fill in once the live session
// aggregator runs, instead of reading empty the way the older seeds did.
//
//   ff9-uc-month-end  "Month-end variance commentary"  Finance, process_mined + canvas — READY
//   ff9-uc-billing    "Client billing pack assembly"    Finance — deliberately NOT ready
//   ff9-uc-timesheets "Automated timesheet approvals"   HR — READY
//   ff9-uc-pipeline   "Weekly sales pipeline review"    Sales — READY
//
// Each daily run cleans and reinserts its own use cases, sessions and prompts,
// so any draft or Board card made in yesterday's demo is reset and the journey
// starts fresh from the first click; the nine people persist. Marker prefix
// `ff9-` on every identifying key.
//
// Run (inside the hub container, DATABASE_URL + CCC_PG_SSL from its env):
//   docker exec -i ccc-hub node < scripts/demo/03-skill-workflows.cjs
//   SEED_CLEAN=1 ...                                   # clean only
// Locally: CCC_PG_SSL=disable DATABASE_URL=postgresql://... node scripts/demo/03-skill-workflows.cjs [--clean]
'use strict';
const { Client } = require('pg');

const CLEAN_ONLY = process.argv.includes('--clean') || process.env.SEED_CLEAN === '1';
const MARKER = 'ff9-';
const DOMAIN = 'acmecorp.example';
const DAY = 86400;
const WEEK = 7 * DAY;
// Monday 00:00 UTC of the week containing ts (epoch 0 was a Thursday; 345600 = Mon 1970-01-05).
const weekStart = (ts) => ts - ((((ts - 345600) % WEEK) + WEEK) % WEEK);

const DEPT_FINANCE = 'Finance';
const DEPT_HR = 'HR';
const DEPT_SALES = 'Sales';

const UC_MONTH_END_ID = `${MARKER}uc-month-end`;
const UC_BILLING_ID = `${MARKER}uc-billing`;
const UC_TIMESHEETS_ID = `${MARKER}uc-timesheets`;
const UC_PIPELINE_ID = `${MARKER}uc-pipeline`;
const UC_IDS = [UC_MONTH_END_ID, UC_BILLING_ID, UC_TIMESHEETS_ID, UC_PIPELINE_ID];
const UC_MONTH_END_TITLE = 'Month-end variance commentary';
const UC_BILLING_TITLE = 'Client billing pack assembly';
const UC_TIMESHEETS_TITLE = 'Automated timesheet approvals';
const UC_PIPELINE_TITLE = 'Weekly sales pipeline review';
const CANVAS_SIGNAL_KEY = `${MARKER}me-canvas`;

const person = (key, name, dept) => ({
  id: `${MARKER}${key}`, name, dept,
  email: `${name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ /g, '.')}@${DOMAIN}`,
});
const ANNA = person('anna', 'Anna Whitfield', DEPT_FINANCE);
const BEN = person('ben', 'Ben Okafor', DEPT_FINANCE);
const CARA = person('cara', 'Cara Lindqvist', DEPT_FINANCE);
const DAN = person('dan', 'Dan Mercer', DEPT_HR);
const EVE = person('eve', 'Eve Castellanos', DEPT_HR);
const FEMI = person('femi', 'Femi Adeyemi', DEPT_HR);
const GUS = person('gus', 'Gus Hartley', DEPT_SALES);
const HANA = person('hana', 'Hana Sato', DEPT_SALES);
const IVAN = person('ivan', 'Ivan Petrov', DEPT_SALES);
const OWEN = person('owen', 'Owen Blake', DEPT_FINANCE);
const LEILA = person('leila', 'Leila Haddad', DEPT_FINANCE);
const TOMAS = person('tomas', 'Tomas Varga', DEPT_FINANCE);
const NADIA = person('nadia', 'Nadia Rossi', DEPT_HR);
const KWAME = person('kwame', 'Kwame Mensah', DEPT_HR);
const ELIN = person('elin', 'Elin Berg', DEPT_HR);
const MARCUS = person('marcus', 'Marcus Reid', DEPT_SALES);
const SOFIA = person('sofia', 'Sofia Lindgren', DEPT_SALES);
const ARJUN = person('arjun', 'Arjun Patel', DEPT_SALES);
const PEOPLE = [ANNA, BEN, CARA, DAN, EVE, FEMI, GUS, HANA, IVAN, OWEN, LEILA, TOMAS, NADIA, KWAME, ELIN, MARCUS, SOFIA, ARJUN];
const FINANCE_TEAM = [ANNA, BEN, CARA, OWEN, LEILA, TOMAS];
const HR_TEAM = [DAN, EVE, FEMI, NADIA, KWAME, ELIN];
const SALES_TEAM = [GUS, HANA, IVAN, MARCUS, SOFIA, ARJUN];

// Thirteen weeks of background history per ready workflow, so the detail
// page reads like a real, long-running workflow — active
// hours by week, a spread of skills / connectors / models, tiers trending
// up, Code sessions alongside Cowork. The authored corpora above stay the
// drafting evidence; these shorter prompts are in the same voice so the
// draft sample only gets more on-topic, never generic.
const HISTORY = {
  [`${MARKER}uc-month-end`]: {
    team: FINANCE_TEAM,
    prompts: [
      'variance commentary for the close, rows pasted from the management accounts export, usual format',
      'draft the board pack commentary for this month, actual vs budget vs prior month, flag anything over threshold',
      'here is the P&L tab from the mgmt accounts, write the variance table and a paragraph per line over threshold',
      'tie the revenue line to salesforce closed-won before writing the commentary, then draft it',
      'commentary for the board pack please, one paragraph per line item, board tone, drivers on every line',
      'update section 3 of the board pack template with this month\u2019s variance commentary',
      'variance commentary from these rows, separate FX on revenue, note any one-offs',
      'write the month-end variance narrative for opex by function from the export below',
      'draft the EBITDA bridge commentary for the pack from the pasted rows',
      'redo the variance commentary with the corrected marketing line, everything else unchanged',
    ],
    followUps: [
      'no bullets, one paragraph per line, and say the driver not just the size',
      'add a two-line summary at the top with the two biggest movers',
      'list the lines you could not explain from the numbers so i can chase the budget holders',
      'tone it down, this reads like a sales pitch not a board note',
    ],
    skills: ['anthropic-skills:xlsx', 'anthropic-skills:docx', 'deep-research'],
    connectors: [['salesforce', 'query_records'], ['Gmail', 'search_threads'], ['google-drive', 'read_file']],
    taskTypes: ['structured_report', 'analysis', 'synthesis'],
    codePrompts: ['write a script that reconciles the management accounts export against the GL extract and lists mismatches', 'add a check to the close script that flags any cost centre with no budget line'],
  },
  [`${MARKER}uc-timesheets`]: {
    team: HR_TEAM,
    prompts: [
      'timesheets for this week attached, check them against the project allocation sheet and list approvals and exceptions',
      'run the weekly timesheet check, usual rules, flag over 40 hours and missing project codes',
      'weekly timesheets pasted below, same check as usual, contractors over PO hours as exceptions',
      'here is the timesheet export, produce the approvals list and the exceptions list',
      'check these timesheets, anything over 40 hours or missing a project code goes on the exceptions list',
      'timesheets for approval attached, usual rules apply, approvals and exceptions',
      'this week\u2019s timesheet export, check against the allocation sheet and let me know what needs approving',
      'weekly timesheet review from the export below, contractors never auto-approved',
      'run the usual timesheet check and give me the two lists',
      'timesheets attached, same as last week, list what i can approve now',
    ],
    followUps: [
      'contractors are never auto-approved, move them to exceptions',
      'a missing project code is always an exception, even under 40 hours',
      'add the reason next to each exception so i do not have to open the sheet',
      'sort the approvals list by team not by name',
    ],
    skills: ['anthropic-skills:xlsx', 'anthropic-skills:docx'],
    connectors: [['google-drive', 'read_file'], ['slack', 'send_message'], ['Gmail', 'search_threads']],
    taskTypes: ['template_population', 'analysis', 'structured_report'],
    codePrompts: ['write a script that pulls the weekly timesheet export and joins it to the project allocation sheet', 'add a rule to the timesheet checker for contractors over their PO hours'],
  },
  [`${MARKER}uc-pipeline`]: {
    team: SALES_TEAM,
    prompts: [
      'monday pipeline review from the CRM export, by stage, movements since last week, stuck deals, forecast',
      'weekly pipeline note please, export pasted, usual sections',
      'pipeline review for the sales meeting, stage names exactly as in the CRM, slipped section at the end',
      'here is the pipeline export, write the review note, weighted and unweighted forecast',
      'pipeline review note from this export, flag anything stuck more than 30 days in a stage',
      'monday pipeline review, same format as last week, one line per deal on movements',
      'weekly pipeline review from the CRM export below, reasons on anything you call at risk',
      'write the pipeline note for the meeting, stages, movements, stuck, slipped, forecast',
      'pipeline review from the export, backwards moves called out separately',
      'this week\u2019s pipeline note from the export, usual sections, keep it short',
    ],
    followUps: [
      'use the CRM stage names, not your own, and never invent a close date',
      'the forecast has to be weighted by stage using the weightings in the export',
      'one line per deal in movements, the meeting is fifteen minutes',
      'add a slipped section with old and new close dates',
    ],
    skills: ['anthropic-skills:xlsx', 'deep-research', 'anthropic-skills:docx'],
    connectors: [['salesforce', 'query_records'], ['Gmail', 'search_threads'], ['slack', 'read_channel']],
    taskTypes: ['structured_report', 'synthesis', 'analysis'],
    codePrompts: ['write a script that pulls the pipeline export from the CRM API and computes the weighted forecast by stage', 'add slipped-close-date detection to the pipeline export script'],
  },
};
const BG_MODELS = ['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'];


// Cowork spend per seeded session (model / cost / tokens), so the Audit Log's
// Session Stats read like real telemetry. Deterministic per session id.
const MODELS = ['claude-sonnet-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

// ─── "Weekly sales pipeline review" corpus, a fourth ready-to-draft
// workflow: 3 Sales people x 3
// weekly sessions, opener + follow-ups, corrections that read as quality
// rules (stage names must match the CRM, no invented close dates, slipped
// deals called out by name), a consistent 30-day stale rule. ───
const GUS_WK1 = [
  'here is the pipeline export from the CRM for this week. write the monday pipeline review note for the sales meeting: deals by stage, what moved since last week, anything stuck more than 30 days in a stage, and the forecast for the quarter',
  'use the exact stage names from the CRM export - Qualify, Propose, Negotiate, Closed Won - not your own words. and dont make up close dates, if the export has no close date say so',
  'add a short section at the end called Slipped, listing any deal whose close date moved out since last week, with the old and new date',
];
const HANA_WK1 = [
  'pipeline review for monday please, CRM export pasted below. same shape as gus does it: by stage, movements, stuck deals, quarter forecast',
  'the forecast should be weighted by stage - use the weightings in the export, not your own. show the unweighted total too',
];
const IVAN_WK1 = [
  'weekly pipeline note from this export. stage summary, movements, stuck over 30 days, forecast',
  "you've called two deals 'at risk' without saying why. either give the reason from the export - no activity, close date slipped, stage went backwards - or leave the label off",
];
const GUS_WK2 = [
  'monday pipeline review, export pasted. usual format - by stage, movements since last week, stuck over 30 days, weighted and unweighted forecast, slipped section at the end',
  'flag the deals that went backwards a stage separately, the sales lead asked for that last week',
];
const HANA_WK2 = [
  'pipeline review note for this week from the CRM export below, same format as last week including the slipped section',
  'keep it to one line per deal in the movements section, the meeting is fifteen minutes',
];
const IVAN_WK2 = [
  'weekly pipeline review from the export, stage names exactly as in the CRM, reasons on anything you call at risk',
];
const GUS_WK3 = [
  'pipeline review for monday, export pasted, you know the format by now - stages, movements, stuck over 30 days, backwards moves, weighted plus unweighted forecast, slipped',
  'and a separate note just for me, not for the meeting: any deal where the owner field is blank in the export',
];
const HANA_WK3 = [
  'this weeks pipeline review note from the CRM export below, usual sections, one line per deal on movements',
];
const IVAN_WK3 = [
  'weekly pipeline note, export below. same rules - CRM stage names, no invented dates, reasons on at-risk',
  'unrelated - what time is the all hands on thursday',
];

// ─── The 19-prompt corpus, verbatim per user per month. ───
const ANNA_JUL = [
  'here are the pasted rows from the management accounts export for June. draft the month-end variance commentary for the board pack. actuals vs budget, same layout as usual: revenue, gross margin, opex by function, EBITDA. flag anything more than 5% or 50k off budget',
  'no - keep it to one paragraph per line item, board tone, no bullet points. and dont explain what a variance is, they know',
  'the marketing opex line - the overspend is the Q3 campaign brought forward from July, can you say that. also separate out FX on revenue, the board asked for that last time',
];
const BEN_JUL = [
  'attached is June mgmt accounts.xlsx. pull the P&L tab into a variance table (actual, budget, variance, variance %) then write commentary for each line over threshold. threshold is 5%. prior month comparison as a second column pls',
  'check the revenue number against salesforce closed-won for June before you write anything, last month they didnt tie and we had to redo it',
  'ok now put it in the board pack template (the docx from last month) section 3, keep the headings, replace the text only. send to me not to james.l@example.com, ill forward',
];
const CARA_JUL = [
  'variance commentary for june please. rows pasted below. usual format',
  "you've written 'costs were higher than expected' three times. each line needs the actual driver - headcount, timing, one-off, rate. if you don't know from the numbers say 'driver to be confirmed with budget holder'",
];
const ANNA_AUG = [
  'July close. rows from the management accounts export pasted. same drill - variance commentary for the board pack, actual vs budget vs prior month, threshold 5% / 50k, one para per line, board tone, FX shown separately on revenue',
  "add a 2 line summary at the top - overall EBITDA vs budget and the two biggest movers. that's what they actually read",
];
const BEN_AUG = [
  'july management accounts attached, do the variance table and commentary. tie revenue to salesforce first. put the result straight into section 3 of the board pack template',
  'the depreciation line moved because of the office fit-out capitalisation, its a one off, say so and note it reverses next month',
];
const CARA_AUG = [
  "july variance commentary. rows below. remember - a driver for every line, no generic 'higher than expected'",
  'also can you list which lines you couldnt explain from the numbers so i can chase the budget holders before thursday',
];
const ANNA_SEP = [
  'august close, rows pasted from the mgmt accounts export. variance commentary for the board pack, you know the format by now',
  'and a quick note for me separately, not for the pack: anything in here that looks like a coding error rather than a real variance',
];
const BEN_SEP = [
  'aug mgmt accounts attached. variance table, commentary, tie revenue to SF closed won, drop into board pack section 3',
];
const CARA_SEP = [
  'august variance commentary pls, rows pasted. drivers on every line, list of unexplained lines at the end',
  'unrelated - can you book me a room for the 1:1s on tuesday',
];

const BILLING_BEN_PROMPT =
  'Assemble the June client billing pack from the time entries export and send it for partner review.';
const BILLING_CARA_PROMPT =
  'Pull the July time entries and put together the billing pack the same as usual, partner wants it by Friday.';

// ─── "Automated timesheet approvals" corpus — 3 Operations people x 3 weekly
// sessions each, opener + 1-2 follow-ups, corrections that read as quality
// rules (contractors never auto-approved; a missing project code is always
// an exception), a consistent 40-hour threshold, and one planted email
// (hr.team@example.com) to prove the PII scrub at draft time. ───
const DAN_WK1 = [
  "here are this week's submitted timesheets from the export. check each line against the project allocation sheet and flag anything over 40 hours, any missing project code, and any contractor over their PO hours",
  'approve the ones that match. for exceptions give the person, the project and the one-line reason, nothing else',
  'no - contractors go on a separate list, and never approve a contractor line, just flag it',
];
const EVE_WK1 = [
  'weekly timesheets pasted below from the export - same check as dan does, project allocation sheet, 40 hour flag, missing project codes',
  "send the approval summary to me, not to payroll, i'll forward it monday",
];
const FEMI_WK1 = [
  'timesheets for my team attached, run the usual check and let me know what needs approving',
];
const DAN_WK2 = [
  'same as last week, timesheets attached, approvals and exceptions list',
  'you approved a line with a missing project code, that must always be an exception',
];
const EVE_WK2 = [
  "this week's timesheets below, usual format, flag anything over 40 hours and any missing project code",
  'add the total approved hours per project at the bottom, finance asked for it',
];
const FEMI_WK2 = [
  'timesheets attached again, same checks as before please',
  'can you cc hr.team@example.com on the approvals in future, they want visibility',
];
const DAN_WK3 = [
  "this week's timesheets from the export, check against the allocation sheet, flag anything over 40 hours or missing a project code, contractors over PO hours as usual",
  "unrelated - what's the wifi password for the boardroom",
];
const EVE_WK3 = [
  'weekly timesheets pasted below, same check as usual, approvals and exceptions',
];
const FEMI_WK3 = [
  'timesheets for approval attached, usual rules apply',
];

async function clean(c) {
  const urls = UC_IDS.map(id => `/use-cases/${id}`);
  // Children before parents; the live classifier may have attached pulse
  // rows to seeded messages since the last run.
  await c.query(`DELETE FROM use_case_skill_drafts WHERE use_case_id = ANY($1::text[])`, [UC_IDS]);
  await c.query(`DELETE FROM skill_library_entries WHERE source_url = ANY($1::text[])`, [urls]);
  await c.query(`DELETE FROM use_case_week_matches WHERE use_case_id = ANY($1::text[])`, [UC_IDS]);
  await c.query(`DELETE FROM use_case_activation_weeks WHERE use_case_id = ANY($1::text[])`, [UC_IDS]);
  // The use_cases rows themselves are KEPT (upserted below): the AI-written
  // impact summary lives on the row (use_cases.impact_summary, generated only
  // when an admin clicks Generate) and the demo keeps it there every day. Drafts,
  // Board entries, weeks and sessions still reset, and the facts the summary
  // states are deterministic per run, so it stays true.
  await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
  // pulse_events also carries a user_id FK (frontier/capability detectors write
  // per-user rows off classified seeded messages) — clear by user too or the
  // users delete below fails. Bit the UAT seeder's --clean on a demo install.
  await c.query(`DELETE FROM pulse_events WHERE user_id LIKE $1`, [`${MARKER}%`]);
  // Every other table with a NO ACTION FK to users.id that the live pipeline
  // can write for a seeded person: alerts (a PII alert on a seeded prompt
  // fired overnight on a demo install and blocked the users delete on
  // once, leaving the use cases deleted and nothing reinserted),
  // classifications / skill runs keyed by user, and analytics snapshots.
  await c.query(`DELETE FROM alerts WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM pulse_classifications WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM pulse_skill_runs WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM analytics_snapshots WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM otel_events WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM compliance_events WHERE user_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM code_session_classifications WHERE session_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM code_otel_metrics WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM code_session_stats WHERE session_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM cowork_skill_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM cowork_mcp_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM cowork_session_stats WHERE session_id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM cowork_sessions WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
  await c.query(`DELETE FROM use_case_suggestions WHERE signal_key = $1`, [CANVAS_SIGNAL_KEY]);
  // The nine seeded people are deliberately NOT deleted. Other daily seeders
  // (chat, alert evidence) attach rows to whichever users exist, and every one
  // of those tables carries a NO ACTION FK to users.id — an earlier run
  // failed on chat_messages after the earlier fix covered alerts. Keeping the
  // users (re-upserted below, ON CONFLICT DO NOTHING) removes the whole class.
  // SEED_CLEAN=1 / --clean also leaves them; a genuine removal is a manual
  // step that deletes their dependants first.
}

// created_at is stamped at the run (not the first-session date): the register
// lists newest-created first, and the four showcase workflows belong at
// the top of the Use Cases page. lifecycle_changed_at keeps the
// first-session date so the lifecycle reads as long-standing.
async function insertUseCase(c, row) {
  await c.query(
    `INSERT INTO use_cases (id, title, description, departments, surfaces, keywords, skills, connectors, task_types,
                            origin, status, capture_method, lifecycle, lifecycle_changed_at, strategic, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9,'confirmed',$10,'adopted',$11,0,$12,$12)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, departments = EXCLUDED.departments,
       keywords = EXCLUDED.keywords, skills = EXCLUDED.skills, connectors = EXCLUDED.connectors, status = 'confirmed',
       lifecycle = 'adopted', created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    [row.id, row.title, row.description, JSON.stringify(row.departments), JSON.stringify(['cowork']),
     JSON.stringify(row.keywords), JSON.stringify(row.skills), JSON.stringify(row.connectors),
     row.origin, row.captureMethod, row.createdAt, row.nowS]);
}

/** One session with N prompts (opener at baseAt, follow-ups +60s), a priced api_request row, and its week match. */
async function seedSession(c, useCaseId, sessionId, user, baseAt, prompts, nowS, opts = {}) {
  const lastAt = baseAt + (prompts.length - 1) * 60;
  const tier = opts.tier ?? 2;
  const taskType = opts.taskType ?? 'structured_report';
  await c.query(
    `INSERT INTO cowork_sessions (id, conversation_id, user_id, started_at, ended_at, source, created_at)
     VALUES ($1,$2,$3,$4,$5,'otel',$4) ON CONFLICT (id) DO NOTHING`,
    [sessionId, `${sessionId}-conv`, user.id, baseAt, lastAt + 60]);
  for (let i = 0; i < prompts.length; i++) {
    const at = baseAt + i * 60;
    await c.query(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, surface, occurred_at, ingested_at, content_preview, content_full, source)
       VALUES ($1,$2,$3,'cowork_user_message','user','cowork',$4,$4,$5,$6,'otel') ON CONFLICT (id) DO NOTHING`,
      [`${sessionId}-msg${i}`, sessionId, user.id, at, prompts[i].slice(0, 80), prompts[i]]);
    // The judged layer: a classification per prompt (tier + a taxonomy task type)
    // so the depth chart ("are they handing it bigger jobs?") has something to draw.
    await c.query(
      `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
       VALUES ($1,$2,$3,$4,0.9,'demo-seed',$5) ON CONFLICT DO NOTHING`,
      [`${sessionId}-msg${i}`, user.id, tier, taskType, at + 120]);
  }
  // Two tool events on the session so it has the >=3 timestamps a gap-based
  // active-time measure needs, and so the tool list is not empty.
  await c.query(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, ingested_at, content_preview, source, tool_success)
     VALUES ($1,$2,$3,'cowork_tool_metadata','cowork',$4,$4,'Read','otel',1), ($5,$2,$3,'cowork_tool_metadata','cowork',$6,$6,'Write','otel',1)
     ON CONFLICT (id) DO NOTHING`,
    [`${sessionId}-tool1`, sessionId, user.id, baseAt + 40, `${sessionId}-tool2`, lastAt + 20]);
  // The spend row the real OTel receiver writes per API call — model + cost +
  // tokens in the exact "<model> | {json}" preview shape the session
  // aggregator parses (lib/pulse/cowork/session-aggregator.ts).
  const h = hash(sessionId);
  const model = (sessionId.includes(`${MARKER}bg-`) ? BG_MODELS : MODELS)[h % (sessionId.includes(`${MARKER}bg-`) ? BG_MODELS.length : MODELS.length)];
  const input = 4000 + (h % 9000);
  const output = 600 + ((h >>> 4) % 2200);
  const cost = model.startsWith('claude-haiku') ? (input * 1 + output * 5) / 1e6
    : model.startsWith('claude-opus') ? (input * 15 + output * 75) / 1e6 : (input * 3 + output * 15) / 1e6;
  const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  await c.query(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, ingested_at, model, cost_usd, token_usage, content_preview, source)
     VALUES ($1,$2,$3,'cowork_api_request','cowork',$4,$4,$5,$6,$7::jsonb,$8,'otel') ON CONFLICT (id) DO NOTHING`,
    [`${sessionId}-api`, sessionId, user.id, lastAt + 30, model, cost.toFixed(6), JSON.stringify(usage), `${model} | ${JSON.stringify(usage)}`]);
  // The session-stats row is written directly (same figures as the api row) so
  // the use case's AI footprint / measured hours read immediately rather than
  // after the hourly aggregator's pass. computed_at sits AFTER the newest row so the aggregator leaves
  // it alone.
  const activeSecs = 300 + (prompts.length - 1) * 120;
  await c.query(
    `INSERT INTO cowork_session_stats (session_id, user_id, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
                                       total_cost_usd, tool_call_count, unique_tools, models_used, duration_secs, first_event_at, last_event_at, upload_count, computed_at, active_secs, produced_output)
     VALUES ($1,$2,$3,$4,0,0,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,1)
     ON CONFLICT DO NOTHING`,
    [sessionId, user.id, input, output, cost.toFixed(6), 2 + (h % 4), JSON.stringify(['Write', 'Read']), JSON.stringify([model]),
     lastAt + 60 - baseAt, baseAt, lastAt + 30, lastAt + 90, activeSecs]);

  // Week match (mirrors lib/usecases/weeks.ts recordWeekMatches).
  const wk = weekStart(baseAt);
  await c.query(
    `INSERT INTO use_case_activation_weeks (use_case_id, week_start, updated_at) VALUES ($1,$2,$3) ON CONFLICT (use_case_id, week_start) DO NOTHING`,
    [useCaseId, wk, nowS]);
  await c.query(
    `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [useCaseId, wk, user.id, sessionId]);
  await c.query(
    `UPDATE use_case_activation_weeks w SET
       distinct_users = (SELECT COUNT(DISTINCT user_id) FROM use_case_week_matches m WHERE m.use_case_id = w.use_case_id AND m.week_start = w.week_start),
       session_count = (SELECT COUNT(DISTINCT CASE WHEN session_id <> '' THEN session_id END) FROM use_case_week_matches m WHERE m.use_case_id = w.use_case_id AND m.week_start = w.week_start),
       matched_messages = matched_messages + $3,
       last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $4),
       measured_duration_secs = COALESCE(measured_duration_secs, 0) + $6,
       updated_at = $5
     WHERE use_case_id = $1 AND week_start = $2`,
    [useCaseId, wk, prompts.length, lastAt, nowS, activeSecs]);
}

/** One skill + one connector invocation on each listed session, so the AI footprint has something to show. */
async function seedInvocations(c, sessions, skill, server, tool) {
  for (const [sid, user, at] of sessions) {
    await c.query(
      `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, invocation_type, surface)
       VALUES ($1,$2,$3,$4,$5,'user_typed','cowork') ON CONFLICT (id) DO NOTHING`,
      [`${sid}-skill`, user.id, sid, skill, at + 30]);
    await c.query(
      `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, surface)
       VALUES ($1,$2,$3,$4,$5,$6,'cowork') ON CONFLICT (id) DO NOTHING`,
      [`${sid}-mcp`, user.id, sid, server, tool, at + 45]);
  }
}

/** A Code session matched into the week: stats, classification, one prompt row, active-time metric. */
async function seedCodeSession(c, useCaseId, sessionId, user, firstAt, tier, prompt, nowS) {
  const lastAt = firstAt + 1800;
  await c.query(
    `INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, error_count, input_tokens, output_tokens, models_json, computed_at, active_secs)
     VALUES ($1,$2,$3,$4,3,6,9,1,12000,2400,$5,$6,1800) ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, user.id, firstAt, lastAt, JSON.stringify({ 'claude-sonnet-5': { input: 12000, output: 2400, cache_creation: 0, cache_read: 30000 } }), lastAt + 60]);
  await c.query(
    `INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
     VALUES ($1,$2,'feature',$3,0.9,'demo-seed','classified',$4) ON CONFLICT DO NOTHING`,
    [sessionId, user.id, tier, lastAt + 60]);
  await c.query(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, surface, occurred_at, ingested_at, content_preview, content_full, source)
     VALUES ($1,$2,$3,'code_user_message','user','code',$4,$4,$5,$6,'otel') ON CONFLICT (id) DO NOTHING`,
    [`${sessionId}-msg0`, sessionId, user.id, firstAt, prompt.slice(0, 80), prompt]);
  await c.query(
    `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, occurred_at)
     VALUES ($1,$2,$3,'claude_code.active_time.total',1800,'user',$4) ON CONFLICT (id) DO NOTHING`,
    [`${sessionId}-active`, user.id, sessionId, lastAt]);
  const wk = weekStart(firstAt);
  await c.query(
    `INSERT INTO use_case_activation_weeks (use_case_id, week_start, updated_at) VALUES ($1,$2,$3) ON CONFLICT (use_case_id, week_start) DO NOTHING`,
    [useCaseId, wk, nowS]);
  await c.query(
    `INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [useCaseId, wk, user.id, sessionId]);
  await c.query(
    `UPDATE use_case_activation_weeks w SET
       distinct_users = (SELECT COUNT(DISTINCT user_id) FROM use_case_week_matches m WHERE m.use_case_id = w.use_case_id AND m.week_start = w.week_start),
       session_count = (SELECT COUNT(DISTINCT CASE WHEN session_id <> '' THEN session_id END) FROM use_case_week_matches m WHERE m.use_case_id = w.use_case_id AND m.week_start = w.week_start),
       measured_duration_secs = COALESCE(measured_duration_secs, 0) + 1800,
       engaged_secs = COALESCE(engaged_secs, 0) + 1800,
       last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $3),
       updated_at = $4
     WHERE use_case_id = $1 AND week_start = $2`,
    [useCaseId, wk, lastAt, nowS]);
}

/**
 * Thirteen completed weeks of background sessions for one workflow: 2-4
 * Cowork sessions a week from the department team, tiers rising from 1 to 3
 * over the window, a skill or connector on about a third of them, a Code
 * session every other week. Deterministic per (workflow, week, n).
 */
async function seedHistory(c, useCaseId, nowS) {
  const h = HISTORY[useCaseId];
  if (!h) return;
  const thisWeek = weekStart(nowS);
  for (let w = 13; w >= 1; w--) {
    const ws = thisWeek - w * WEEK;
    const progress = (13 - w) / 12; // 0 → 1 across the window
    const n = 2 + (hash(`${useCaseId}-${w}`) % 3); // 2..4 sessions
    for (let k = 0; k < n; k++) {
      const key = `${useCaseId}-w${w}-${k}`;
      const hk = hash(key);
      const user = h.team[hk % h.team.length];
      const sid = `${key.replace(`${MARKER}uc-`, `${MARKER}bg-`)}`;
      const at = ws + (hk % (5 * DAY)) + 8 * 3600 + ((hk >>> 3) % (9 * 3600)); // Mon-Fri, 08:00-17:00 UTC
      const nPrompts = 1 + ((hk >>> 5) % 3);
      const prompts = [h.prompts[hk % h.prompts.length]];
      for (let f = 1; f < nPrompts; f++) prompts.push(h.followUps[(hk + f) % h.followUps.length]);
      // Tier trends up: early weeks mostly 1-2, late weeks mostly 2-3.
      const roll = (hk >>> 8) % 100;
      const tier = roll < 40 * (1 - progress) ? 1 : (roll < 40 + 30 * (1 - progress) ? 2 : 3);
      const taskType = h.taskTypes[(hk >>> 2) % h.taskTypes.length];
      await seedSession(c, useCaseId, sid, user, at, prompts, nowS, { tier, taskType });
      if ((hk >>> 6) % 3 === 0) {
        const skill = h.skills[(hk >>> 9) % h.skills.length];
        await c.query(
          `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, invocation_type, surface)
           VALUES ($1,$2,$3,$4,$5,'user_typed','cowork') ON CONFLICT (id) DO NOTHING`,
          [`${sid}-skill`, user.id, sid, skill, at + 30]);
      }
      if ((hk >>> 7) % 3 === 1) {
        const [server, tool] = h.connectors[(hk >>> 10) % h.connectors.length];
        await c.query(
          `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, surface)
           VALUES ($1,$2,$3,$4,$5,$6,'cowork') ON CONFLICT (id) DO NOTHING`,
          [`${sid}-mcp`, user.id, sid, server, tool, at + 45]);
      }
    }
    if (w % 2 === 0) {
      const hk = hash(`${useCaseId}-code-${w}`);
      const user = h.team[hk % h.team.length];
      const tier = progress > 0.5 ? 3 : 2;
      await seedCodeSession(c, useCaseId, `${useCaseId.replace(`${MARKER}uc-`, `${MARKER}cd-`)}-w${w}`, user, ws + 2 * DAY + 10 * 3600, tier, h.codePrompts[hk % h.codePrompts.length], nowS);
    }
  }
}

async function seed(c) {
  const nowS = Math.floor(Date.now() / 1000);

  for (const p of PEOPLE) {
    await c.query(
      `INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'otel',$5,$6) ON CONFLICT DO NOTHING`,
      [p.id, p.email, p.name, p.dept, nowS - 90 * DAY, nowS]);
  }

  // ─── Month-end variance commentary — 9 sessions, 19 prompts, 3 people x jul/aug/sep.
  const JUL_BASE = nowS - 80 * DAY;
  const AUG_BASE = nowS - 50 * DAY;
  const SEP_BASE = nowS - 20 * DAY;
  await insertUseCase(c, {
    id: UC_MONTH_END_ID, title: UC_MONTH_END_TITLE,
    description: 'Month-end commentary is hand-assembled from pasted spreadsheet rows drawn from the management accounts export each close, checked against Salesforce closed-won, and dropped into the board pack template.',
    departments: [DEPT_FINANCE], keywords: ['variance commentary', 'management accounts'],
    skills: ['anthropic-skills:xlsx'], connectors: ['salesforce'],
    origin: 'emergent', captureMethod: 'process_mined', createdAt: JUL_BASE, nowS,
  });
  const me = [
    [`anna-jul`, ANNA, JUL_BASE, ANNA_JUL], [`ben-jul`, BEN, JUL_BASE + DAY, BEN_JUL], [`cara-jul`, CARA, JUL_BASE + 2 * DAY, CARA_JUL],
    [`anna-aug`, ANNA, AUG_BASE, ANNA_AUG], [`ben-aug`, BEN, AUG_BASE + DAY, BEN_AUG], [`cara-aug`, CARA, AUG_BASE + 2 * DAY, CARA_AUG],
    [`anna-sep`, ANNA, SEP_BASE, ANNA_SEP], [`ben-sep`, BEN, SEP_BASE + DAY, BEN_SEP], [`cara-sep`, CARA, SEP_BASE + 2 * DAY, CARA_SEP],
  ];
  for (const [sid, u, at, prompts] of me) await seedSession(c, UC_MONTH_END_ID, `${MARKER}${sid}`, u, at, prompts, nowS);
  await c.query(
    `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, invocation_type, surface)
     VALUES ($1,$2,$3,'anthropic-skills:xlsx',$4,'user_typed','cowork') ON CONFLICT (id) DO NOTHING`,
    [`${MARKER}anna-skill-1`, ANNA.id, `${MARKER}anna-sep`, SEP_BASE]);
  await c.query(
    `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, surface)
     VALUES ($1,$2,$3,'salesforce','query_records',$4,'cowork') ON CONFLICT (id) DO NOTHING`,
    [`${MARKER}anna-mcp-1`, ANNA.id, `${MARKER}anna-sep`, SEP_BASE]);
  await c.query(
    `INSERT INTO use_case_suggestions (id, signal_key, title, description, matching_rule, evidence, status, generated_at, updated_at, department, canvas_json)
     VALUES ($1,$1,$2,$3,$4,$5,'added',$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [CANVAS_SIGNAL_KEY, UC_MONTH_END_TITLE,
     'Month-end commentary appears hand-assembled from pasted spreadsheet rows drawn from the management accounts export each close. The same three people repeat the assembly step every month before the board pack goes out.',
     JSON.stringify({ skills: ['anthropic-skills:xlsx'], connectors: ['salesforce'], taskTypes: [], departments: [DEPT_FINANCE], keywords: ['management accounts', 'variance commentary'] }),
     JSON.stringify({ distinctUsers: 3, sessionCount: 9, departments: [DEPT_FINANCE] }),
     JUL_BASE, nowS, DEPT_FINANCE,
     JSON.stringify({
       story: 'Month-end commentary is hand-assembled from pasted spreadsheet rows drawn from the management accounts export each close, checked against Salesforce closed-won, and dropped into the board pack template.',
       valueHypothesis: 'Feeding the board-pack template directly from the export and Salesforce would turn assembly into review.',
       people: 3, sessions: 9, occasions: 3, windowDays: 90,
       rhythm: { label: 'monthly', display: 'Monthly, month-end spike' },
       systems: ['anthropic-skills:xlsx', 'salesforce'], activeHours: 5.0, tierNote: 'Mostly tier 2',
     })]);

  // ─── Client billing pack assembly — 2 people, 2 single-prompt sessions: honestly NOT ready.
  await insertUseCase(c, {
    id: UC_BILLING_ID, title: UC_BILLING_TITLE,
    description: 'The monthly client billing pack is assembled by hand from the time entries export and sent for partner review.',
    departments: [DEPT_FINANCE], keywords: ['billing pack', 'time entries'], skills: [], connectors: [],
    origin: 'planned', captureMethod: 'guided', createdAt: nowS - 45 * DAY, nowS,
  });
  await seedSession(c, UC_BILLING_ID, `${MARKER}ben-billing`, BEN, nowS - 40 * DAY, [BILLING_BEN_PROMPT], nowS);
  await seedSession(c, UC_BILLING_ID, `${MARKER}cara-billing`, CARA, nowS - 10 * DAY, [BILLING_CARA_PROMPT], nowS);

  // ─── Automated timesheet approvals (HR) and Weekly sales pipeline review (Sales):
  // 3 people x 3 weekly sessions each, offset so all 9 sessions land on distinct days.
  const WK1_BASE = nowS - 20 * DAY;
  const WK2_BASE = nowS - 13 * DAY;
  const WK3_BASE = nowS - 6 * DAY;
  await insertUseCase(c, {
    id: UC_TIMESHEETS_ID, title: UC_TIMESHEETS_TITLE,
    description: 'Weekly timesheets are checked by hand against the project allocation sheet - hours over 40, missing project codes, contractors over their PO hours - before being approved or listed as exceptions.',
    departments: [DEPT_HR], keywords: ['timesheet', 'approve'], skills: [], connectors: [],
    origin: 'planned', captureMethod: 'guided', createdAt: nowS - 12 * 7 * DAY, nowS,
  });
  const ts = [
    [`dan-wk1`, DAN, WK1_BASE, DAN_WK1], [`eve-wk1`, EVE, WK1_BASE + DAY, EVE_WK1], [`femi-wk1`, FEMI, WK1_BASE + 2 * DAY, FEMI_WK1],
    [`dan-wk2`, DAN, WK2_BASE, DAN_WK2], [`eve-wk2`, EVE, WK2_BASE + DAY, EVE_WK2], [`femi-wk2`, FEMI, WK2_BASE + 2 * DAY, FEMI_WK2],
    [`dan-wk3`, DAN, WK3_BASE, DAN_WK3], [`eve-wk3`, EVE, WK3_BASE + DAY, EVE_WK3], [`femi-wk3`, FEMI, WK3_BASE + 2 * DAY, FEMI_WK3],
  ];
  for (const [sid, u, at, prompts] of ts) await seedSession(c, UC_TIMESHEETS_ID, `${MARKER}${sid}`, u, at, prompts, nowS);
  await seedInvocations(c, [[`${MARKER}dan-wk3`, DAN, WK3_BASE], [`${MARKER}eve-wk2`, EVE, WK2_BASE + DAY]], 'anthropic-skills:xlsx', 'google-drive', 'read_file');

  await insertUseCase(c, {
    id: UC_PIPELINE_ID, title: UC_PIPELINE_TITLE,
    description: 'Every Monday the CRM pipeline export is turned into the sales meeting note by hand - deals by stage, movements since last week, deals stuck in a stage, slipped close dates and the weighted quarter forecast.',
    departments: [DEPT_SALES], keywords: ['pipeline', 'forecast'], skills: [], connectors: [],
    origin: 'planned', captureMethod: 'guided', createdAt: nowS - 12 * 7 * DAY, nowS,
  });
  const pl = [
    [`gus-wk1`, GUS, WK1_BASE + 3 * DAY, GUS_WK1], [`hana-wk1`, HANA, WK1_BASE + 4 * DAY, HANA_WK1], [`ivan-wk1`, IVAN, WK1_BASE + 5 * DAY, IVAN_WK1],
    [`gus-wk2`, GUS, WK2_BASE + 3 * DAY, GUS_WK2], [`hana-wk2`, HANA, WK2_BASE + 4 * DAY, HANA_WK2], [`ivan-wk2`, IVAN, WK2_BASE + 5 * DAY, IVAN_WK2],
    [`gus-wk3`, GUS, WK3_BASE + 3 * DAY, GUS_WK3], [`hana-wk3`, HANA, WK3_BASE + 4 * DAY, HANA_WK3], [`ivan-wk3`, IVAN, WK3_BASE + 5 * DAY, IVAN_WK3],
  ];
  for (const [sid, u, at, prompts] of pl) await seedSession(c, UC_PIPELINE_ID, `${MARKER}${sid}`, u, at, prompts, nowS);

  // ─── Thirteen weeks of background history behind each ready workflow.
  await seedHistory(c, UC_MONTH_END_ID, nowS);
  await seedHistory(c, UC_TIMESHEETS_ID, nowS);
  await seedHistory(c, UC_PIPELINE_ID, nowS);
  await seedInvocations(c, [[`${MARKER}gus-wk3`, GUS, WK3_BASE + 3 * DAY], [`${MARKER}hana-wk2`, HANA, WK2_BASE + 4 * DAY]], 'anthropic-skills:xlsx', 'salesforce', 'query_records');

  const counts = await c.query(
    `SELECT (SELECT COUNT(*) FROM users WHERE id LIKE $1) AS users,
            (SELECT COUNT(*) FROM cowork_sessions WHERE id LIKE $1) AS sessions,
            (SELECT COUNT(*) FROM cowork_messages WHERE id LIKE $1 AND message_type = 'cowork_user_message') AS prompts,
            (SELECT COUNT(*) FROM cowork_messages WHERE id LIKE $1 AND message_type = 'cowork_api_request') AS spend_rows,
            (SELECT COUNT(*) FROM use_cases WHERE id = ANY($2::text[])) AS use_cases`,
    [`${MARKER}%`, UC_IDS]);
  console.log('[sample-skill-workflows] inserted:', counts.rows[0]);
  console.log(`[sample-skill-workflows] ready: /use-cases/${UC_MONTH_END_ID}, /use-cases/${UC_TIMESHEETS_ID}, /use-cases/${UC_PIPELINE_ID}; not ready: /use-cases/${UC_BILLING_ID}`);
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
      const left = await c.query(`SELECT COUNT(*) AS n FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
      console.log(`[sample-skill-workflows] clean: done, ${left.rows[0].n} marker rows remain.`);
      return;
    }
    await seed(c);
    console.log('[sample-skill-workflows] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

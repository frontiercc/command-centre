// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample data: Claude in Office (Excel, Word, PowerPoint, Outlook) and Claude
// in Google (Sheets, Docs, Slides). Google rows carry no document file name:
// the Google add-on sends none.
//
// Gives existing sample people realistic Office work over the last 60 days, in
// the exact shape lib/otel/office-receiver.ts writes from the add-in's spans:
//   cowork_sessions          one per Office session, product set
//   cowork_messages          cowork_user_message (the prompt), cowork_api_request
//                            (model + tokens, cost_usd NULL), cowork_tool_metadata
//                            (tool name, success, tool_parameters read_write /
//                            changed_document, document file name on changes)
//   pulse_classifications    a tier and kind of work per prompt, so the
//                            classifier finds nothing to spend API calls on
//   cowork_session_stats     tokens, tools, active time and produced_output,
//                            written now (computed_at = now) so the panels are
//                            right straight after loading
// Which apps a person uses follows their department (Finance leans on Excel,
// Legal and HR on Word, Sales and Marketing on PowerPoint, everyone a little
// Outlook). Deterministic: the same people and work each load, dated relative
// to the run.
//
// Every id starts with `ff14-`; each run removes its own rows first, so it is
// safe to re-run. load.cjs clears pulse_classifications for the prefix
// before running it.
//
// Run by load.cjs (docker compose --profile demo run --rm demo-data).
// Clean only: node scripts/demo/09b-office.cjs --clean
'use strict';
const { Client } = require('pg');

const CLEAN_ONLY = process.argv.includes('--clean') || process.env.SEED_CLEAN === '1';
const MARKER = 'ff14-';
const DAY = 86400;
const WINDOW_DAYS = 60;
const PEOPLE = 24;

// [prompt, document, tier, kind of work, changes the document]
const WORK = {
  excel: {
    surface: 'sheet', reads: ['get_range_as_csv', 'get_cell_ranges'], write: 'execute_office_js',
    jobs: [
      ['Build a pivot of this quarter\'s pipeline by region and flag deals slipping more than 30 days', 'Pipeline tracker.xlsx', 2, 'analysis', true],
      ['Reconcile the two supplier tabs and list every invoice where the totals disagree', 'Supplier reconciliation.xlsx', 3, 'analysis', true],
      ['Add a monthly variance column against budget and highlight anything over ten per cent', 'Budget vs actuals.xlsx', 2, 'structured_report', true],
      ['Clean the duplicate customer rows and standardise the country names', 'Customer master.xlsx', 1, 'formatting', true],
      ['Forecast next quarter\'s revenue from the last eight quarters and show the working', 'Revenue model.xlsx', 3, 'analysis', true],
      ['Chart headcount by department for the last six quarters', 'Headcount plan.xlsx', 2, 'structured_report', true],
      ['Explain what the formula in column H is doing', 'Budget vs actuals.xlsx', 1, 'summarisation', false],
      ['What is the average deal size in this sheet?', 'Pipeline tracker.xlsx', 1, 'analysis', false],
      ['Build a commission calculation for each rep using the tiered rates on the second tab', 'Commission calculator.xlsx', 3, 'template_population', true],
      ['Flag any expense lines over the policy limit and total them by cost centre', 'Expense claims.xlsx', 2, 'analysis', true],
      ['Turn this raw export into a clean monthly summary with one row per account', 'CRM export.xlsx', 2, 'formatting', true],
      ['Which three products grew fastest year on year?', 'Product sales.xlsx', 1, 'analysis', false],
    ],
  },
  word: {
    surface: 'doc', reads: ['read_doc_section', 'retrieve_snipped'], write: 'propose_doc_edits',
    jobs: [
      ['Tighten the executive summary of this proposal to one page and keep the pricing table', 'Client proposal.docx', 2, 'structured_report', true],
      ['Turn these meeting notes into a decisions and actions memo', 'Steering group notes.docx', 2, 'synthesis', true],
      ['Rewrite section 3 in plain English for a non-technical board', 'Board paper.docx', 3, 'structured_report', true],
      ['Check this contract summary for inconsistent dates and party names', 'Contract summary.docx', 2, 'analysis', false],
      ['Draft a cover letter for the tender using the scope in section 2', 'Tender response.docx', 3, 'synthesis', true],
      ['Summarise this policy in five bullet points', 'Travel policy.docx', 1, 'summarisation', false],
      ['Mark up this supplier agreement against our standard terms and list the deviations', 'Supplier agreement.docx', 3, 'analysis', true],
      ['Update the job description for the new team lead role from the notes at the end', 'Job description.docx', 2, 'template_population', true],
      ['Make the tone of this customer letter warmer without changing the commitments', 'Customer letter.docx', 1, 'basic_drafting', true],
      ['Pull the key risks out of this report into a one-page brief', 'Quarterly risk report.docx', 2, 'research_brief', true],
    ],
  },
  powerpoint: {
    surface: 'slide', reads: ['verify_slides', 'get_slide_text'], write: 'execute_office_js',
    jobs: [
      ['Make a five-slide summary of the quarterly results from this deck', 'Quarterly results.pptx', 3, 'synthesis', true],
      ['Restyle these slides to the new template and fix the chart labels', 'Sales kickoff.pptx', 1, 'formatting', true],
      ['Add speaker notes to each slide for the client workshop', 'Client workshop.pptx', 2, 'structured_report', true],
      ['Turn the project timeline table into a visual roadmap slide', 'Programme update.pptx', 2, 'synthesis', true],
      ['Build a pitch deck outline for the renewal meeting from the account notes', 'Renewal pitch.pptx', 3, 'structured_report', true],
      ['Which slides mention the pricing change?', 'Sales kickoff.pptx', 1, 'summarisation', false],
      ['Condense this twenty-slide deck to an eight-slide board version', 'Strategy review.pptx', 3, 'synthesis', true],
      ['Add a competitor comparison slide using the table on slide 12', 'Market update.pptx', 2, 'analysis', true],
    ],
  },
  outlook: {
    surface: 'mail', reads: ['read_mail_thread'], write: 'draft_reply',
    jobs: [
      ['Summarise this thread and draft a reply agreeing the revised timeline', 'Revised timeline', 1, 'basic_drafting', true],
      ['Draft a polite chase for the overdue purchase order approval', 'Purchase order approval', 1, 'basic_drafting', true],
      ['What did the client agree to in this thread?', 'Contract renewal', 1, 'summarisation', false],
      ['Draft a reply declining the meeting and suggesting two other times', 'Quarterly review meeting', 1, 'basic_drafting', true],
      ['Pull every action for me out of this long thread', 'Programme board actions', 2, 'summarisation', false],
    ],
  },
  sheets: {
    surface: 'sheet', reads: ['get_cell_ranges'], write: 'execute_apps_script',
    jobs: [
      ['Build a weekly summary tab of open support tickets by priority', null, 2, 'structured_report', true],
      ['Flag any marketing spend rows with no campaign code and total them by channel', null, 3, 'analysis', true],
      ['Add a running total column to the bookings sheet', null, 1, 'formatting', true],
      ['Match the event sign-ups against the CRM list and mark who is new', null, 2, 'analysis', true],
      ['Which region had the highest renewal rate last quarter?', null, 1, 'analysis', false],
    ],
  },
  docs: {
    surface: 'doc', reads: ['read_doc_section'], write: 'execute_apps_script',
    jobs: [
      ['Turn these interview notes into a one-page hiring recommendation', null, 2, 'synthesis', true],
      ['Rewrite the onboarding guide intro for new starters outside engineering', null, 2, 'structured_report', true],
      ['Draft a project brief from the kickoff notes, with scope, owners and dates', null, 3, 'synthesis', true],
      ['Summarise this document in three sentences', null, 1, 'summarisation', false],
    ],
  },
  slides: {
    surface: 'slide', reads: ['list_slide_shapes', 'verify_slide_visual'], write: 'execute_apps_script',
    jobs: [
      ['Build a six-slide customer case study from the outline on slide one', null, 3, 'synthesis', true],
      ['Tidy the alignment and fonts across the team update deck', null, 1, 'formatting', true],
      ['Add a timeline slide for the launch plan from the dates in the notes', null, 2, 'structured_report', true],
    ],
  },
};

// Sessions a person has in each app over the window, by department.
// The Google apps come last, so adding them left every person's Office sessions unchanged.
const MIX = [
  [/financ|account|procure/i, { excel: 9, word: 2, powerpoint: 2, outlook: 3, sheets: 3, docs: 1, slides: 0 }],
  [/legal|hr|people|compliance/i, { excel: 1, word: 8, powerpoint: 1, outlook: 3, sheets: 0, docs: 3, slides: 0 }],
  [/sales|marketing|commercial|business dev/i, { excel: 3, word: 3, powerpoint: 7, outlook: 3, sheets: 1, docs: 1, slides: 3 }],
  [/operat|delivery|engineering|product|it\b|technology/i, { excel: 5, word: 3, powerpoint: 3, outlook: 2, sheets: 2, docs: 2, slides: 1 }],
];
const DEFAULT_MIX = { excel: 3, word: 3, powerpoint: 3, outlook: 2, sheets: 1, docs: 1, slides: 1 };
const MODELS = ['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5', 'claude-opus-5-5'];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function client() {
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  return new Client({ connectionString: process.env.DATABASE_URL, ssl });
}

async function clean(db) {
  const like = `${MARKER}%`;
  await db.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [like]);
  await db.query(`DELETE FROM use_case_week_matches WHERE session_id LIKE $1`, [like]);
  await db.query(`DELETE FROM use_case_session_judgements WHERE session_id LIKE $1`, [like]);
  await db.query(`DELETE FROM cowork_session_descriptions WHERE session_id LIKE $1`, [like]);
  await db.query(`DELETE FROM cowork_session_stats WHERE session_id LIKE $1`, [like]);
  await db.query(`DELETE FROM cowork_messages WHERE session_id LIKE $1`, [like]);
  await db.query(`DELETE FROM cowork_sessions WHERE id LIKE $1`, [like]);
}

async function main() {
  const db = client();
  await db.connect();
  try {
    await db.query('BEGIN');
    await clean(db);
    if (CLEAN_ONLY) { await db.query('COMMIT'); console.log('[sample-office] cleaned'); return; }

    // Existing demo people with a department, steadiest first (by id, so the same people every day).
    // One row per person, even when several sign-ins link to them.
    const people = (await db.query(`
      SELECT id, dept FROM (
        SELECT DISTINCT ON (u.id) u.id, COALESCE(au.department, u.department) AS dept
          FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
         WHERE COALESCE(au.department, u.department) IS NOT NULL
           AND u.email LIKE '%@%' AND u.email NOT LIKE '%@test.local'
           AND EXISTS (SELECT 1 FROM cowork_messages cm WHERE cm.user_id = u.id AND cm.message_type = 'cowork_user_message')
         ORDER BY u.id, au.department NULLS LAST
      ) p
       ORDER BY md5(id) LIMIT $1`, [PEOPLE])).rows;
    if (!people.length) throw new Error('no demo people with a department');

    const now = Math.floor(Date.now() / 1000);
    let sessions = 0;
    let n = 0;
    const id = () => `${MARKER}${(++n).toString(36).padStart(6, '0')}`;

    for (const person of people) {
      const r = rng(hashStr(person.id));
      const mix = (MIX.find(([re]) => re.test(person.dept)) || [null, DEFAULT_MIX])[1];
      for (const [product, count] of Object.entries(mix)) {
        const w = WORK[product];
        for (let s = 0; s < count; s++) {
          const job = w.jobs[Math.floor(r() * w.jobs.length)];
          const [prompt, docName, tier, kind, changes] = job;
          const day = 1 + Math.floor(r() * (WINDOW_DAYS - 1));
          let t = now - day * DAY + Math.floor((8.5 + r() * 9) * 3600);
          if (t > now - 1800) t = now - 1800 - Math.floor(r() * 3600);
          const sessionId = `${MARKER}${product}-${hashStr(`${person.id}:${product}:${s}`).toString(36)}`;
          const model = pick(r, MODELS);
          const start = t;
          await db.query(
            `INSERT INTO cowork_sessions (id, conversation_id, user_id, source, product, started_at, created_at)
             VALUES ($1, $1, $2, 'otel', $3, $4, $5)`, [sessionId, person.id, product, start, now]);

          const traceId = hashStr(sessionId).toString(16).padStart(8, '0') + 'a'.repeat(24);
          const promptId = id();
          await db.query(
            `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, prompt_id, content_preview, content_full, flagged, occurred_at)
             VALUES ($1, $2, $3, 'cowork_user_message', 'cowork', 'otel', $4, $5, $6, $6, 0, $7)`,
            [promptId, sessionId, person.id, product, traceId, prompt, t]);
          await db.query(
            `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
             VALUES ($1, $2, $3, $4, 0.88, 'seeded', $5)`, [promptId, person.id, tier, kind, t + 300]);

          const calls = 2 + Math.floor(r() * 3);
          const tools = new Set();
          let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheWrite = 0, toolCalls = 0;
          const stamps = [t];
          for (let c = 0; c < calls; c++) {
            t += 4 + Math.floor(r() * 20);
            const usage = {
              inputTokens: 1500 + Math.floor(r() * 7000), outputTokens: 250 + Math.floor(r() * 1600),
              cacheReadTokens: 6000 + Math.floor(r() * 24000), cacheCreationTokens: 800 + Math.floor(r() * 1500),
            };
            tokensIn += usage.inputTokens; tokensOut += usage.outputTokens; cacheRead += usage.cacheReadTokens; cacheWrite += usage.cacheCreationTokens;
            const json = JSON.stringify(usage);
            await db.query(
              `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, prompt_id, model, token_usage, content_preview, occurred_at)
               VALUES ($1, $2, $3, 'cowork_api_request', 'cowork', 'otel', $4, $5, $6, $7::jsonb, $8, $9)`,
              [id(), sessionId, person.id, product, traceId, model, json, `${model} | ${json}`, t]);
            stamps.push(t);
            if (c === calls - 1) break;
            t += 2 + Math.floor(r() * 8);
            const write = changes && c === calls - 2;
            const tool = write ? w.write : w.reads[c % w.reads.length];
            const readWrite = tool === 'propose_doc_edits' ? 'read' : (write ? 'write' : 'read');
            tools.add(tool);
            toolCalls++;
            await db.query(
              `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, prompt_id, tool_success, tool_duration_ms, content_preview, tool_parameters, output_name, occurred_at)
               VALUES ($1, $2, $3, 'cowork_tool_metadata', 'cowork', 'otel', $4, $5, 1, $6, $7, $8::jsonb, $9, $10)`,
              [id(), sessionId, person.id, product, traceId, 400 + Math.floor(r() * 2600), tool,
                JSON.stringify({ read_write: readWrite, changed_document: write, accept_decision: write ? 'manual' : 'auto_accept', owner: 'first_party' }),
                write ? docName : null, t]);
            stamps.push(t);
          }

          stamps.sort((a, b) => a - b);
          let active = 0;
          for (let i = 1; i < stamps.length; i++) { const gap = stamps[i] - stamps[i - 1]; if (gap <= 1800) active += gap; }
          await db.query(
            `INSERT INTO cowork_session_stats (session_id, user_id, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
               total_cost_usd, tool_call_count, unique_tools, models_used, duration_secs, first_event_at, last_event_at, upload_count, computed_at, active_secs, produced_output)
             VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, 0, $13, $14, $15)`,
            [sessionId, person.id, tokensIn, tokensOut, cacheRead, cacheWrite, toolCalls, JSON.stringify([...tools]), JSON.stringify([model]),
              stamps[stamps.length - 1] - stamps[0], stamps[0], stamps[stamps.length - 1], now, active, changes ? 1 : 0]);
          sessions++;
        }
      }
    }
    await db.query('COMMIT');
    console.log(`[sample-office] ${sessions} Office and Google sessions for ${people.length} people`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

main().catch(e => { console.error('[sample-office] failed:', e.message); process.exit(1); });

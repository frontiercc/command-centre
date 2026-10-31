// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Mock OpenAI Compliance Logs Platform data, for building and testing the
// ChatGPT and Codex sync on localhost without a ChatGPT Enterprise workspace.
//
// Records follow OpenAI's published formats (Admin API spec v2.5.40, read
// 2026-10-31): CONVERSATION_MESSAGE, CODEX_LOG, CODEX_TURN and COSTS. People
// are the fictional Acme Corp staff from ../demo/acme-people.json, so the
// sync's people match the sample organisation's departments, plus two people
// who are not in it, so creating a new person is exercised too.
//
// The data also carries the awkward cases a real export has: the same event
// in two files, events arriving in a later file, an edited message, temporary
// and locked chats, ChatGPT Work recorded in both CONVERSATION_MESSAGE and
// CODEX_LOG, personal data and risky requests in prompts, costs billed in
// credits and in dollars, a cost row with no email, and an agent's cost row
// with no person. See README.md for what is assumed rather than documented.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ID = '7f3c2a10-5b1e-4c8d-9a6f-0e2d4b8c1a55';
export const ORGANIZATION_ID = 'org-MockAcmeCorp000000000000';
const WINDOW_MS = 10 * 60 * 1000;
// Mock credit price used for estimated_cost_usd. The real figure is each
// workspace's credit overage rate.
const USD_PER_CREDIT = 0.04;

// ── Deterministic randomness ────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const r = mulberry32(seed);
  const rng = {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let x = r() * total;
      for (const [v, w] of pairs) {
        if ((x -= w) < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
    uuid: () => {
      const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    id: (prefix, len = 24) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      return prefix + Array.from({ length: len }, () => chars[Math.floor(r() * chars.length)]).join('');
    },
  };
  return rng;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const isoSec = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// ── People ──────────────────────────────────────────────────────────────────
function loadPeople(rng) {
  const all = JSON.parse(readFileSync(path.join(here, '..', 'demo', 'acme-people.json'), 'utf8'));
  const byDept = {};
  for (const p of all) (byDept[p.department] ??= []).push(p);
  const toActor = (p) => ({
    email: p.email,
    name: p.display_name,
    department: p.department,
    userId: rng.id('user-', 24),
  });
  const chatgpt = [];
  for (const [dept, people] of Object.entries(byDept)) {
    const n = dept === 'Engineering' ? 2 : Math.min(people.length, 4);
    for (const p of people.slice(0, n)) chatgpt.push(toActor(p));
  }
  const codex = byDept.Engineering.slice(2, 10).map(toActor);
  codex.push(toActor(byDept.Product[0]));
  // Two people Command Centre has never seen, to exercise creating a person.
  chatgpt.push({ email: 'nadia.okafor@acmecorp.example', name: 'Nadia Okafor', department: 'Finance', userId: rng.id('user-', 24) });
  codex.push({ email: 'tom.brennan@acmecorp.example', name: 'Tom Brennan', department: 'Engineering', userId: rng.id('user-', 24) });
  return { chatgpt, codex };
}

// ── Prompt banks ────────────────────────────────────────────────────────────
// Each opener comes with follow-ups that read as the same piece of work.
const CHAT_WORK = {
  Sales: [
    ['Draft a follow-up email to the procurement lead at Harbourline after yesterday\'s demo. They asked about SSO and data residency.',
      'Make it shorter and drop the pricing paragraph.', 'Add a line offering a call with our security team next week.'],
    ['Summarise this call transcript into next steps, risks and owners for the Brightwater renewal.',
      'Turn the risks into a table with likelihood and mitigation.', 'What should I ask their CFO on Thursday?'],
    ['Build a one-page account plan for Northgate Logistics using the notes below.',
      'Rewrite the value section for a COO rather than a CIO.'],
    ['Compare our pricing tiers against the competitor sheet I uploaded and flag where we lose on price.',
      'Which three objections should the team prepare for?'],
  ],
  'Customer Success': [
    ['Write a QBR summary for Fenwick Retail from the usage notes and support tickets attached.',
      'Add a section on adoption risks in the London stores.', 'Make the tone more upbeat for the exec slide.'],
    ['Draft a reply to this escalation about delayed onboarding. Be honest about the cause.',
      'Shorten it to five sentences.'],
    ['Group these 40 support tickets by root cause and count each group.',
      'Which root cause would cut the most tickets if we fixed it?'],
  ],
  Legal: [
    ['Review this NDA and list any clauses that differ from our standard mutual NDA.',
      'Suggest redlines for the non-solicitation clause.', 'Draft a cover note to the counterparty explaining the changes.'],
    ['Summarise the key obligations in this data processing agreement for the ops team.',
      'Which obligations need a named owner?'],
    ['Compare the limitation of liability clauses in these two supplier contracts.',
      'Which one is more favourable to us and why?'],
  ],
  HR: [
    ['Draft a job description for a senior data engineer, hybrid in Manchester.',
      'Make the requirements list shorter and more inclusive.', 'Write three screening questions.'],
    ['Turn these exit interview notes into themes we can share with the leadership team.',
      'Remove anything that could identify an individual.'],
    ['Write an onboarding checklist for new starters in the finance team.',
      'Split it into week one and month one.'],
  ],
  Finance: [
    ['Explain the variance between budget and actuals for Q3 marketing spend using the table below.',
      'Write it as three bullet points for the board pack.', 'Which line items need a reforecast?'],
    ['Build a cash flow forecast template for the next 13 weeks.',
      'Add a scenario where the two largest customers pay 30 days late.'],
    ['Check this supplier invoice list for duplicates and invoices without a PO number.',
      'Draft an email to accounts payable about the duplicates.'],
    ['Summarise month-end close issues from these notes into a checklist for next month.',
      'Which items can be automated?'],
  ],
  Marketing: [
    ['Write three LinkedIn posts announcing our new analytics feature for operations leaders.',
      'Make the second one less salesy.', 'Suggest an image idea for each post.'],
    ['Analyse this campaign results table and tell me which channel had the best cost per lead.',
      'Draft a short note for the CMO with a recommendation.'],
    ['Create a content calendar for November around the retail operations theme.',
      'Add owners and due dates.'],
  ],
  Product: [
    ['Turn these customer interview notes into a problem statement and three opportunity areas.',
      'Which opportunity has the strongest evidence?', 'Draft a one-page brief for the strongest one.'],
    ['Write release notes for the October release from the ticket list below, for customers not engineers.',
      'Shorten each item to one sentence.'],
    ['Prioritise this backlog using reach, impact, confidence and effort.',
      'Explain the top three choices for the steering group.'],
  ],
  Engineering: [
    ['Explain the difference between eventual and strong consistency for the architecture review doc.',
      'Give an example from an order processing system.'],
    ['Draft an incident summary for last night\'s payments outage from the timeline below.',
      'Add a section on what we will change.'],
  ],
};

// Work-mode tasks: longer, agentic, produce files.
const WORK_TASKS = [
  ['Pull the Q3 pipeline export from the shared drive, build a forecast workbook by region and flag deals slipping more than 30 days.', 'q3-forecast-by-region.xlsx'],
  ['Read the five supplier contracts in the Legal folder and produce a comparison table of renewal dates, notice periods and liability caps.', 'supplier-contract-comparison.xlsx'],
  ['Go through last month\'s support tickets, group them by root cause and write a two-page summary for the CS leadership meeting.', 'support-root-causes-september.docx'],
  ['Build a 10-slide deck on the retail operations campaign results for Friday\'s marketing review.', 'retail-campaign-results.pptx'],
  ['Reconcile the expense report CSV against the card statement and list every mismatch with the amount.', 'expense-reconciliation.xlsx'],
  ['Research the three main competitors\' pricing pages and produce a pricing comparison document with sources.', 'competitor-pricing-comparison.docx'],
];

const CODEX_WORK = [
  ['Add pagination to the /api/orders endpoint and update the tests.',
    'The test for the last page is failing, fix it.', 'Now update the API docs for the new parameters.', 'Commit this with a clear message.'],
  ['Find why the nightly import job times out on large files.',
    'Stream the file instead of reading it into memory.', 'Add a test with a 50MB fixture generated at runtime.'],
  ['Refactor the invoice PDF generator to use the new template engine.',
    'Keep the old output byte-identical for existing invoices.', 'Run the full test suite and fix anything that breaks.'],
  ['Write a migration that adds a currency column to payments, defaulting to GBP.',
    'Backfill existing rows in batches of 10,000.', 'Commit and open a PR.'],
  ['Review this diff for security issues before I merge it.',
    'Fix the SQL injection risk you found.'],
  ['Explain how the auth middleware decides which routes are public.',
    'Add a test that fails if a new route is public by accident.'],
  ['Upgrade the date library to the latest major version and fix the breaking changes.',
    'Two snapshot tests changed, check whether the new output is correct.', 'Commit the upgrade.'],
  ['The checkout page is slow on mobile, profile the bundle and suggest what to split.',
    'Lazy load the reviews widget and the map.', 'Measure the bundle again.'],
  ['Add retry with exponential backoff to the webhook sender, capped at five attempts.',
    'Make the cap a config value.', 'Commit this.'],
  ['Write unit tests for the discount calculator, including the edge cases around zero and negative totals.',
    'One case shows a real bug with negative totals, fix the code not the test.'],
];

const CODEX_AUTOMATION = 'Run the dependency audit, open an issue for any high severity finding and post a summary.';

// Prompts that personal-data and risky-intent detection must catch.
const SENSITIVE_PROMPTS = [
  'Draft a letter to our employee about her payroll correction. Her details: Sarah Whitfield, NI number JX 41 72 85 B, mobile 07700 900123.',
  'Here is the customer list with emails, can you clean it: j.smith@harbourline.example, priya.rao@brightwater.example, m.lee@fenwick.example',
  'Export the full customer database with contact details into a CSV I can send to my personal Gmail before I leave next week.',
  'How do I get the admin passwords for the finance system without IT knowing?',
];

// Codex prompts that must raise alerts: a quoted password, an access key, an
// export to a personal account and switching off logging. None mentions a
// commit, so swapping one in never changes what else the session generates.
const CODEX_SENSITIVE_PROMPTS = [
  'Connect to the reporting database with password = "Wint3r!2026" and run the migration.',
  'Use AWS key AKIAIOSFODNN7EXAMPLE to list the buckets in the billing account.',
  'Write a script that copies the customer table to my personal Dropbox every night.',
  'Disable logging on the payments service while we run this batch so nobody sees it.',
];

const CHAT_REPLIES = [
  'Here is a draft you can adapt. I have kept it short and put the next steps first.',
  'I have grouped the points into three themes and listed an owner for each.',
  'Below is a table with the comparison. The main differences are in the second and fourth rows.',
  'Here is a revised version with the changes you asked for.',
  'I have summarised the key points and flagged two items that need a decision.',
];

const CODEX_REPLIES = [
  'I updated the handler and added tests. All tests pass locally.',
  'The cause is the file being read fully into memory. I switched it to a stream and added a test.',
  'Done. I committed the change with a message describing the fix.',
  'I found one issue: user input is concatenated into the query. I replaced it with a parameterised query.',
  'The suite passes. Two snapshots changed because the new version formats time zones differently, and the new output is correct.',
];

const CHAT_MODELS = [['gpt-5.5', 70], ['gpt-5-mini', 22], ['gpt-5.5-pro', 8]];
const WORK_MODELS = [['gpt-5.5', 85], ['gpt-5.5-pro', 15]];
const CODEX_MODELS = [['gpt-5.5-codex', 75], ['gpt-5-codex-mini', 25]];
const CLIENT_TYPES = [['desktop_web', 50], ['macos_app', 20], ['windows_app', 15], ['ios_app', 10], ['android_app', 5]];
const CODEX_CLIENTS = [['CODEX_CLI', 40], ['CODEX_IDE_VSCODE', 30], ['CODEX_DESKTOP_APP', 15], ['CODEX_IDE_JETBRAINS_INTELLIJ_IDEA', 10], ['CODEX_WEB', 5]];

// Mock per-million-token prices in credits, used only to build COSTS and
// CODEX_TURN figures.
const CREDITS_PER_MTOK = {
  'gpt-5.5': { in: 31.25, cached: 3.125, out: 250 },
  'gpt-5-mini': { in: 6.25, cached: 0.625, out: 50 },
  'gpt-5.5-pro': { in: 375, cached: 375, out: 3000 },
  'gpt-5.5-codex': { in: 31.25, cached: 3.125, out: 250 },
  'gpt-5-codex-mini': { in: 6.25, cached: 0.625, out: 50 },
};

function envelope(type, rng, timestampMs, actor) {
  return {
    event_id: rng.uuid(),
    type,
    timestamp: iso(timestampMs),
    principal: { id: WORKSPACE_ID, type: 'CHATGPT_WORKSPACE' },
    actor: { type: 'ACCOUNT_USER', user_id: actor.userId, user_email: actor.email },
  };
}

// Midnight UTC of every day in the range.
function dayStarts(startMs, endMs) {
  const days = [];
  const d0 = new Date(startMs);
  d0.setUTCHours(0, 0, 0, 0);
  for (let t = d0.getTime(); t < endMs; t += 86_400_000) days.push(t);
  return days;
}
const isWeekend = (dayMs) => [0, 6].includes(new Date(dayMs).getUTCDay());

/**
 * Builds every event, with the time each one becomes available in a file.
 * Returns { events: [{ eventType, availableAt, record }] }.
 */
export function buildEvents({ nowMs, days = 14, horizonHours = 24, seed = 42 }) {
  const rng = makeRng(seed);
  // A separate stream for the Codex risky prompts, so adding them leaves every
  // other generated id and time exactly as before.
  const sensitiveRng = makeRng(seed + 7);
  const codexSensitiveLeft = [...CODEX_SENSITIVE_PROMPTS];
  const { chatgpt, codex } = loadPeople(rng);
  const startMs = nowMs - days * 86_400_000;
  const endMs = nowMs + horizonHours * 3_600_000;
  const events = [];
  // usage[hourKey|email|model|product|client] → { actor, tokens… }
  const usage = new Map();
  const addUsage = (ms, actor, model, product, client, inTok, cachedTok, outTok, usd) => {
    const hour = Math.floor(ms / 3_600_000) * 3_600_000;
    const key = `${hour}|${actor.email}|${model}|${product}|${client}`;
    const u = usage.get(key) ?? { hour, actor, model, product, client, in: 0, cached: 0, out: 0, usd: !!usd };
    u.in += inTok; u.cached += cachedTok; u.out += outTok;
    usage.set(key, u);
  };
  const latency = () => rng.int(60_000, 25 * 60_000); // p99 < 30 min
  const push = (eventType, eventMs, record, extraDelay = 0) =>
    events.push({ eventType, availableAt: eventMs + latency() + extraDelay, record });

  let sensitiveLeft = [...SENSITIVE_PROMPTS];
  const allDays = dayStarts(startMs, endMs);
  const weekdays = allDays.filter((d) => !isWeekend(d));

  // ── ChatGPT Chat and Work ────────────────────────────────────────────────
  let tempChatDone = false;
  let lockedChatDone = false;
  let editDone = false;
  for (const actor of chatgpt) {
    const bank = CHAT_WORK[actor.department] ?? CHAT_WORK.Product;
    for (const day of allDays) {
      // Weekends are quiet, not empty, so new files keep appearing while testing.
      if (isWeekend(day) && !rng.chance(0.15)) continue;
      const convs = rng.weighted([[0, 25], [1, 35], [2, 25], [3, 15]]);
      for (let c = 0; c < convs; c++) {
        let t = day + rng.int(8 * 60, 17 * 60) * 60_000 + rng.int(0, 59_000);
        if (t >= endMs) continue;
        const isWork = rng.chance(0.22);
        const clientType = rng.weighted(CLIENT_TYPES);
        const model = rng.weighted(isWork ? WORK_MODELS : CHAT_MODELS);
        const conversation = {
          id: rng.uuid(),
          title: '',
          mode: isWork ? 'work' : 'chat',
          created_at: isoSec(t),
          is_pinned: false,
          is_temporary_chat: false,
          is_locked_chat: false,
        };
        if (!tempChatDone && rng.chance(0.05)) { conversation.is_temporary_chat = true; tempChatDone = true; }
        else if (!lockedChatDone && rng.chance(0.05)) { conversation.is_locked_chat = true; lockedChatDone = true; }
        if (!isWork && rng.chance(0.12)) { conversation.gpt_id = 'g-AcmeBrandVoice'; conversation.gpt_name = 'Acme Brand Voice'; }
        if (rng.chance(0.15)) { conversation.project_id = rng.id('g-p-', 16); conversation.project_name = `${actor.department} planning`; }

        let turns;
        let outputFile = null;
        if (isWork) {
          const [task, file] = rng.pick(WORK_TASKS);
          turns = [task, 'Use the latest version of the file, not last month\'s.'].slice(0, rng.int(1, 2));
          outputFile = file;
        } else {
          const thread = rng.pick(bank);
          turns = thread.slice(0, rng.int(1, thread.length));
        }
        if (sensitiveLeft.length && rng.chance(0.04)) turns = [sensitiveLeft.shift(), ...turns.slice(1)];
        conversation.title = turns[0].split(/[.,]/)[0].slice(0, 60);

        let prevId;
        for (let i = 0; i < turns.length; i++) {
          // User message
          const userMsg = {
            ...envelope('CONVERSATION_MESSAGE', rng, t, actor),
            ...(prevId ? { previous_message_id: prevId } : {}),
            message: {
              id: rng.uuid(),
              created_at: iso(t),
              author: { type: 'user', client_type: clientType },
              content: { type: 'text', value: turns[i] },
              ...(i === 0 && rng.chance(0.25) ? { files: [{ id: rng.id('file-', 22), name: `${actor.department.toLowerCase().replace(/ /g, '-')}-notes.pdf` }] } : {}),
            },
            conversation,
          };
          push('CONVERSATION_MESSAGE', t, userMsg);
          // One edited message: same message.id, later event, new text.
          if (!editDone && i === 0 && rng.chance(0.03)) {
            const edited = structuredClone(userMsg);
            edited.event_id = rng.uuid();
            edited.timestamp = iso(t + 45_000);
            edited.message.content.value = `${turns[i]} Keep it under 200 words.`;
            push('CONVERSATION_MESSAGE', t + 45_000, edited);
            editDone = true;
          }
          prevId = userMsg.message.id;

          // ChatGPT Work is also recorded in CODEX_LOG with a CODEX_WORK_* client.
          // No shared identifier with the conversation is documented, so none is
          // given here: the sync must match on person, text and time.
          const workSession = isWork ? `work-${rng.uuid()}` : null;
          const workClient = clientType === 'desktop_web' ? 'CODEX_WORK_WEB'
            : clientType.endsWith('_app') && !clientType.startsWith('ios') && !clientType.startsWith('android') ? 'CODEX_WORK_DESKTOP'
            : 'CODEX_WORK_MOBILE';
          if (isWork) {
            push('CODEX_LOG', t + 800, {
              ...envelope('CODEX_LOG', rng, t + 800, actor),
              event_type: 'PROMPT_SENT',
              client_id: workClient,
              workspace_id: WORKSPACE_ID,
              event_details: { detail_type: 'PROMPT_SENT', session_id: workSession, prompt_text: turns[i], model, environment_id: null },
            });
          }

          // Assistant reply
          t += rng.int(isWork ? 90_000 : 6_000, isWork ? 600_000 : 70_000);
          const tools = isWork ? ['file_search', 'python', rng.pick(['browser', 'canvas'])] : (rng.chance(0.3) ? [rng.pick(['browser', 'python', 'file_search'])] : undefined);
          const skills = rng.chance(0.12) ? [rng.pick(['pdfs', 'spreadsheets', 'slides'])] : undefined;
          const lastTurn = i === turns.length - 1;
          const replyFiles = outputFile && lastTurn
            ? [{ id: rng.id('file-', 22), name: outputFile }]
            : (!isWork && rng.chance(0.06) ? [{ id: rng.id('file-', 22), name: 'draft.docx' }] : undefined);
          const reply = {
            ...envelope('CONVERSATION_MESSAGE', rng, t, actor),
            previous_message_id: prevId,
            message: {
              id: rng.uuid(),
              created_at: iso(t),
              author: {
                type: 'assistant',
                model,
                ...(tools ? { tools_used: tools } : {}),
                ...(skills ? { skills_used: skills.map((s) => `skill-${s}`), skills_used_names: skills } : {}),
              },
              content: { type: 'text', value: rng.pick(CHAT_REPLIES) },
              ...(replyFiles ? { files: replyFiles } : {}),
            },
            conversation,
          };
          push('CONVERSATION_MESSAGE', t, reply);
          prevId = reply.message.id;

          const inTok = rng.int(isWork ? 20_000 : 800, isWork ? 140_000 : 9_000);
          const cachedTok = Math.floor(inTok * (isWork ? rng.next() * 0.7 : rng.next() * 0.3));
          const outTok = rng.int(isWork ? 2_000 : 150, isWork ? 12_000 : 1_800);
          if (isWork) {
            push('CODEX_LOG', t + 500, {
              ...envelope('CODEX_LOG', rng, t + 500, actor),
              event_type: 'PROMPT_RESPONSE_RECEIVED',
              client_id: workClient,
              workspace_id: WORKSPACE_ID,
              event_details: {
                detail_type: 'PROMPT_RESPONSE_RECEIVED', session_id: workSession, response_text: reply.message.content.value,
                status: 'completed', model,
                token_usage: { input_tokens: inTok, output_tokens: outTok, cached_input_tokens: cachedTok, reasoning_output_tokens: Math.floor(outTok * 0.4) },
                environment_id: null,
              },
            });
          }
          // One person is billed in native USD, everyone else in credits.
          addUsage(t, actor, model, 'chatgpt', clientType.includes('app') ? clientType.replace('_app', '') : 'web',
            inTok - cachedTok, cachedTok, outTok, actor === chatgpt[1]);
          t += rng.int(60_000, 15 * 60_000);
        }
      }
    }
  }

  // ── Codex ────────────────────────────────────────────────────────────────
  const turnRecords = [];
  for (const actor of codex) {
    for (const day of allDays) {
      if (isWeekend(day) ? !rng.chance(0.15) : rng.chance(0.15)) continue; // a day off Codex
      const sessions = rng.weighted([[1, 35], [2, 40], [3, 20], [4, 5]]);
      for (let s = 0; s < sessions; s++) {
        let t = day + rng.int(8 * 60 + 30, 17 * 60 + 30) * 60_000;
        if (t >= endMs) continue;
        const client = rng.weighted(CODEX_CLIENTS);
        const sessionId = rng.uuid();
        const model = rng.weighted(CODEX_MODELS);
        const thread = rng.pick(CODEX_WORK);
        const prompts = thread.slice(0, rng.int(1, thread.length));
        if (sensitiveLeft.length && rng.chance(0.03)) prompts.unshift(sensitiveLeft.shift());
        // Risky Codex prompts land in the last three days, in place of the
        // session's opening prompt.
        if (codexSensitiveLeft.length && t > nowMs - 3 * 86_400_000 && t < nowMs
          && !/commit/i.test(prompts[0]) && sensitiveRng.chance(0.25)) {
          prompts[0] = codexSensitiveLeft.shift();
        }
        for (const prompt of prompts) {
          const turnId = rng.uuid();
          const callId = rng.id('resp_', 20);
          const started = t;
          push('CODEX_LOG', t, {
            ...envelope('CODEX_LOG', rng, t, actor),
            event_type: 'PROMPT_SENT', client_id: client, workspace_id: WORKSPACE_ID,
            event_details: { detail_type: 'PROMPT_SENT', session_id: sessionId, prompt_text: prompt, turn_id: turnId, call_id: callId, model, environment_id: null },
          });
          // Tool calls: reads, patches, shell commands, an occasional failure,
          // a commit when the prompt asks for one.
          const nTools = rng.int(1, 7);
          const wantsCommit = /commit/i.test(prompt);
          let failed = 0;
          for (let k = 0; k < nTools; k++) {
            t += rng.int(2_000, 40_000);
            const kind = rng.weighted([['read_file', 35], ['apply_patch', 30], ['shell', 35]]);
            const fails = kind === 'shell' && rng.chance(0.15);
            if (fails) failed++;
            const input = kind === 'shell'
              ? { command: ['npm', 'test', '--', '--run'] }
              : { path: rng.pick(['src/api/orders.ts', 'src/jobs/import.ts', 'src/billing/invoice-pdf.ts', 'test/orders.test.ts']) };
            push('CODEX_LOG', t, {
              ...envelope('CODEX_LOG', rng, t, actor),
              event_type: fails ? 'TOOL_CALL_FAILED' : 'TOOL_CALL_COMPLETED', client_id: client, workspace_id: WORKSPACE_ID,
              event_details: {
                detail_type: fails ? 'TOOL_CALL_FAILED' : 'TOOL_CALL_COMPLETED', session_id: sessionId,
                tool_name: kind, tool_type: 'function', tool_input: JSON.stringify(input),
                turn_id: turnId, call_id: callId, tool_call_id: rng.id('call_', 20), status: fails ? 'failed' : 'completed', model, environment_id: null,
              },
            });
          }
          if (wantsCommit) {
            t += rng.int(3_000, 20_000);
            push('CODEX_LOG', t, {
              ...envelope('CODEX_LOG', rng, t, actor),
              event_type: 'TOOL_CALL_COMPLETED', client_id: client, workspace_id: WORKSPACE_ID,
              event_details: {
                detail_type: 'TOOL_CALL_COMPLETED', session_id: sessionId, tool_name: 'shell', tool_type: 'function',
                tool_input: JSON.stringify({ command: ['git', 'commit', '-m', 'Mock commit message'] }),
                turn_id: turnId, call_id: callId, tool_call_id: rng.id('call_', 20), status: 'completed', model, environment_id: null,
              },
            });
          }
          // A connector call now and then.
          const usedMcp = rng.chance(0.12);
          if (usedMcp) {
            t += rng.int(2_000, 15_000);
            const mcpCall = rng.id('mcp_', 16);
            push('CODEX_LOG', t, {
              ...envelope('CODEX_LOG', rng, t, actor),
              event_type: 'APP_MCP_CALL', client_id: client, workspace_id: WORKSPACE_ID,
              event_details: { detail_type: 'APP_MCP_CALL', call_id: mcpCall, name: 'linear.create_issue', arguments: { title: 'Follow-up from Codex session' }, tool_meta: { connector: 'linear' } },
            });
            push('CODEX_LOG', t + 1_200, {
              ...envelope('CODEX_LOG', rng, t + 1_200, actor),
              event_type: 'APP_MCP_RESULT', client_id: client, workspace_id: WORKSPACE_ID,
              event_details: { detail_type: 'APP_MCP_RESULT', call_id: mcpCall, name: 'linear.create_issue', status: 'success', result_preview: 'Created issue ENG-1042' },
            });
          }
          t += rng.int(5_000, 90_000);
          const inTok = rng.int(8_000, 120_000);
          const cachedTok = Math.floor(inTok * (0.4 + rng.next() * 0.5));
          const outTok = rng.int(300, 6_000);
          const reasoningTok = Math.floor(outTok * (0.2 + rng.next() * 0.5));
          push('CODEX_LOG', t, {
            ...envelope('CODEX_LOG', rng, t, actor),
            event_type: 'PROMPT_RESPONSE_RECEIVED', client_id: client, workspace_id: WORKSPACE_ID,
            event_details: {
              detail_type: 'PROMPT_RESPONSE_RECEIVED', session_id: sessionId, response_text: rng.pick(CODEX_REPLIES),
              status: 'completed', turn_id: turnId, call_id: callId, model, service_tier: 'default', reasoning_effort: rng.pick(['low', 'medium', 'high']),
              token_usage: { input_tokens: inTok, output_tokens: outTok, cached_input_tokens: cachedTok, reasoning_output_tokens: reasoningTok },
              environment_id: null,
            },
          });
          addUsage(t, actor, model, 'codex', client.replace('CODEX_', '').toLowerCase(), inTok - cachedTok, cachedTok, outTok, false);
          turnRecords.push({ actor, started, completed: t, turnId, sessionId, client, model, inTok, cachedTok, outTok, failed, usedMcp, automation: false });
          t += rng.int(60_000, 20 * 60_000);
        }
      }
    }
  }

  // One engineer runs a daily Codex automation at 07:00 UTC.
  const automator = codex[0];
  for (const day of weekdays) {
    const t = day + 7 * 3_600_000 + rng.int(0, 120_000);
    if (t >= endMs) continue;
    const sessionId = rng.uuid();
    const turnId = rng.uuid();
    const model = 'gpt-5-codex-mini';
    push('CODEX_LOG', t, {
      ...envelope('CODEX_LOG', rng, t, automator),
      event_type: 'PROMPT_SENT', client_id: 'CODEX_SERVICE_EXEC', workspace_id: WORKSPACE_ID,
      event_details: { detail_type: 'PROMPT_SENT', session_id: sessionId, prompt_text: CODEX_AUTOMATION, turn_id: turnId, model, environment_id: null },
    });
    const done = t + rng.int(60_000, 300_000);
    const inTok = rng.int(20_000, 60_000);
    const cachedTok = Math.floor(inTok * 0.8);
    const outTok = rng.int(500, 2_000);
    push('CODEX_LOG', done, {
      ...envelope('CODEX_LOG', rng, done, automator),
      event_type: 'PROMPT_RESPONSE_RECEIVED', client_id: 'CODEX_SERVICE_EXEC', workspace_id: WORKSPACE_ID,
      event_details: {
        detail_type: 'PROMPT_RESPONSE_RECEIVED', session_id: sessionId, response_text: 'No high severity findings. Summary posted.',
        status: 'completed', turn_id: turnId, model,
        token_usage: { input_tokens: inTok, output_tokens: outTok, cached_input_tokens: cachedTok, reasoning_output_tokens: Math.floor(outTok * 0.3) },
        environment_id: null,
      },
    });
    addUsage(done, automator, model, 'codex', 'service_exec', inTok - cachedTok, cachedTok, outTok, false);
    turnRecords.push({ actor: automator, started: t, completed: done, turnId, sessionId, client: 'CODEX_SERVICE_EXEC', model, inTok, cachedTok, outTok, failed: 0, usedMcp: false, automation: true });
  }

  // A plugin install, once.
  if (weekdays.length) {
    const t = weekdays[0] + 10 * 3_600_000;
    push('CODEX_LOG', t, {
      ...envelope('CODEX_LOG', rng, t, codex[1]),
      event_type: 'PLUGIN_INSTALLED', client_id: 'CODEX_DESKTOP_APP', workspace_id: WORKSPACE_ID,
      event_details: {
        detail_type: 'PLUGIN_INSTALLED', plugin_id: 'plugin_linear', plugin_release_id: 'release_linear_3', plugin_version: '3.1.0',
        plugin_name: 'linear', plugin_display_name: 'Linear', marketplace_name: 'openai-curated', plugin_scope: 'GLOBAL',
      },
    });
  }

  // ── CODEX_TURN: one per turn, ~2 hours after its UTC hour ────────────────
  const CLASSES = [['code_implementation', 'feature_development'], ['code_implementation', 'bug_fixing'], ['code_review', 'security_review'], ['testing', 'unit_tests'], ['code_understanding', 'explanation'], ['maintenance', 'dependency_upgrade']];
  for (const tr of turnRecords) {
    const hour = Math.floor(tr.started / 3_600_000) * 3_600_000;
    const hourEnd = hour + 3_600_000 - 1_000;
    const rate = CREDITS_PER_MTOK[tr.model];
    const credits = +(((tr.inTok - tr.cachedTok) * rate.in + tr.cachedTok * rate.cached + tr.outTok * rate.out) / 1e6).toFixed(4);
    const [l1, l2] = tr.automation ? ['maintenance', 'dependency_upgrade'] : rng.pick(CLASSES);
    events.push({
      eventType: 'CODEX_TURN',
      availableAt: hour + 2 * 3_600_000 + rng.int(5, 40) * 60_000,
      record: {
        ...envelope('CODEX_TURN', rng, hourEnd, tr.actor),
        timestamp: isoSec(hourEnd),
        payload: {
          hour_partition: new Date(hour).toISOString().slice(0, 13),
          turn_id: tr.turnId, turn_key: `${tr.sessionId}:${tr.turnId}`, thread_id: tr.sessionId, session_id: tr.sessionId,
          product_client_id: tr.client, model: tr.model, reasoning_effort: 'medium', speed: 'standard',
          started_at: iso(tr.started), completed_at: iso(tr.completed), duration_ms: tr.completed - tr.started, response_count: 1,
          classification: { taxonomy_version: 'v1', level_1: l1, level_2: l2 },
          credits, estimated_cost_usd: +(credits * USD_PER_CREDIT).toFixed(4),
          tags: tr.automation ? ['automation'] : [],
          token_usage: { uncached_input_tokens: tr.inTok - tr.cachedTok, cached_input_tokens: tr.cachedTok, output_tokens: tr.outTok },
          skills: [],
          plugins: tr.usedMcp ? [{ plugin_id: 'plugin_linear', plugin_name: 'linear', plugin_category: 'productivity', marketplace_name: 'openai-curated', call_count: 1 }] : [],
          artifact_actions: [],
        },
      },
    });
  }

  // ── COSTS: hourly, per person, model, product and client, 3-5 h late ─────
  const groupIds = {};
  const groupFor = (dept) => ({ id: (groupIds[dept] ??= createHash('md5').update(dept).digest('hex')), name: dept });
  let noEmailDone = false;
  for (const u of usage.values()) {
    const hourEnd = u.hour + 3_600_000 - 1_000;
    const rate = CREDITS_PER_MTOK[u.model];
    const lines = [
      ['input', u.in, rate.in],
      ['cached_input', u.cached, rate.cached],
      ['output', u.out, rate.out],
    ].filter(([, q]) => q > 0);
    const billing = lines.map(([kind, q, r]) => {
      const value = +(q * r / 1e6).toFixed(4);
      return u.usd
        ? { sku: `${u.product}.${u.model}.${kind}`, quantity: { value: q, unit: 'tokens' }, cost: { value: +(value * USD_PER_CREDIT).toFixed(4), unit: 'USD' } }
        : { sku: `${u.product}.${u.model}.${kind}`, quantity: { value: q, unit: 'tokens' }, cost: { value, unit: 'CREDITS' }, estimated_cost_usd: { value: +(value * USD_PER_CREDIT).toFixed(4), unit: 'USD' } };
    });
    const identity = { user_id: u.actor.userId, email: u.actor.email, name: u.actor.name, groups: [groupFor(u.actor.department)] };
    if (!noEmailDone && u.product === 'chatgpt' && rng.chance(0.01)) {
      delete identity.email; delete identity.name; noEmailDone = true;
    }
    events.push({
      eventType: 'COSTS',
      availableAt: u.hour + rng.int(3 * 60, 5 * 60) * 60_000,
      record: {
        event_id: rng.uuid(), type: 'COSTS', timestamp: isoSec(hourEnd),
        principal: { id: ORGANIZATION_ID, type: 'API_PLATFORM_ORG' },
        actor: { type: 'SYSTEM', id: 'costs_compliance' },
        payload: {
          day: new Date(u.hour).toISOString().slice(0, 10), hour: new Date(u.hour).getUTCHours(), organization_id: ORGANIZATION_ID,
          identity, product: u.product, surface: u.product, client: u.client, model: u.model,
          service_tier: 'default', reasoning: 'medium',
          measures: {
            usage: { text_input_tokens: u.in, text_cached_input_tokens: u.cached, text_output_tokens: u.out },
            billing,
          },
        },
      },
    });
  }
  // A Workspace Agent's usage: no person attached.
  if (weekdays.length) {
    const hour = weekdays[weekdays.length - 2] + 11 * 3_600_000;
    events.push({
      eventType: 'COSTS', availableAt: hour + 4 * 3_600_000,
      record: {
        event_id: rng.uuid(), type: 'COSTS', timestamp: isoSec(hour + 3_599_000),
        principal: { id: ORGANIZATION_ID, type: 'API_PLATFORM_ORG' }, actor: { type: 'SYSTEM', id: 'costs_compliance' },
        payload: {
          day: new Date(hour).toISOString().slice(0, 10), hour: 11, organization_id: ORGANIZATION_ID,
          identity: { groups: [], agent: { id: 'agt_procurement', name: 'Procurement Review Agent' } },
          product: 'workspace_agents', surface: 'chatgpt', client: 'web', model: 'gpt-5.5', service_tier: 'default', reasoning: 'medium',
          measures: {
            usage: { text_input_tokens: 42_000, text_cached_input_tokens: 0, text_output_tokens: 3_100 },
            billing: [{ sku: 'workspace_agents.gpt-5.5', quantity: { value: 45_100, unit: 'tokens' }, cost: { value: 2.09, unit: 'CREDITS' }, estimated_cost_usd: { value: 0.0836, unit: 'USD' } }],
          },
        },
      },
    });
  }

  return { events, people: { chatgpt, codex } };
}

/**
 * Packs events into ~10-minute files per event type, like the real export:
 * a file holds the events available by its end_time, about 2% of events
 * appear again in the next file (at-least-once delivery), and each file
 * carries its SHA-256.
 */
export function buildFiles(events, { seed = 42 } = {}) {
  const rng = makeRng(seed + 1);
  const byType = new Map();
  for (const e of events) {
    const windowEnd = Math.ceil(e.availableAt / WINDOW_MS) * WINDOW_MS;
    const key = `${e.eventType}|${windowEnd}`;
    const bucket = byType.get(key) ?? { eventType: e.eventType, endMs: windowEnd, records: [] };
    bucket.records.push(e.record);
    byType.set(key, bucket);
    if (rng.chance(0.02)) {
      const nextKey = `${e.eventType}|${windowEnd + WINDOW_MS}`;
      const next = byType.get(nextKey) ?? { eventType: e.eventType, endMs: windowEnd + WINDOW_MS, records: [] };
      next.records.push(e.record);
      byType.set(nextKey, next);
    }
  }
  const files = [];
  for (const b of byType.values()) {
    b.records.sort((a, z) => a.timestamp.localeCompare(z.timestamp));
    const body = b.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const endTime = new Date(b.endMs).toISOString().replace('.000Z', 'Z');
    files.push({
      id: `clf_${createHash('sha256').update(`${b.eventType}|${b.endMs}`).digest('hex').slice(0, 24)}`,
      event_type: b.eventType,
      end_time: endTime,
      endMs: b.endMs,
      file_name: `${b.eventType.toLowerCase()}_${endTime.replace(/[:]/g, '-')}.jsonl`,
      file_size: Buffer.byteLength(body),
      file_sha256: createHash('sha256').update(body).digest('hex'),
      body,
      maxEventMs: Math.max(...b.records.map((r) => Date.parse(r.timestamp))),
    });
  }
  files.sort((a, z) => a.endMs - z.endMs || a.event_type.localeCompare(z.event_type));
  return files;
}

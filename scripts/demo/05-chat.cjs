#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Chat surface was never covered by any of the other sample
// scripts, so the dashboard's 14-Day Adoption Trend chart's Chat line has
// always been genuinely zero for every day without an old analytics_snapshots
// row — not a caching artefact, an actual data gap. This fills it in, using
// the SAME deterministic quiet-user gate as the other scripts (matching
// formula, so a user "gone quiet recently" there is quiet here too).
//
// Real chat capture is via the Compliance API (source='compliance'), never
// OTel — matches the capture-path rule the rest of this codebase follows.
//
// Marker `ff7-`. Re-running clears + reinserts its own rows first.
// Usage: docker exec -i ccc-hub node < scripts/demo/05-chat.cjs [-- --clean]
const { Client } = require('pg');

const MARKER = 'ff7-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const N_DAYS = 60; // covers the 14-day chart window plus a longer trail

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

// Same formula as 01-organisation.cjs/-v2.cjs/-v5.cjs — MUST match exactly
// so a user already "gone quiet recently" there is quiet here too.
function isRecentlyQuiet(userId, chance) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000 < chance;
}
const CODE_INTENSITY = { Engineering: 'high', Enablement: 'high', Platform: 'high', Data: 'high', AppliedAI: 'high', Product: 'medium' };
const intensityFor = (dept) => CODE_INTENSITY[dept] || 'low';
function quietChanceFor(intensity) {
  return intensity === 'high' ? 0.1 : intensity === 'medium' ? 0.25 : 0.4;
}

// Forty distinct prompts (was ten: with ~80 chat rows a day the Audit Log's
// newest page read as the same handful of lines over and over).
const CHAT_PROMPTS = [
  'Can you help me draft a follow-up email after today’s client call?',
  'Summarise this article into three key takeaways.',
  'What’s a good structure for a quarterly business review?',
  'Rewrite this paragraph to be clearer and more concise.',
  'Help me prepare talking points for the team meeting.',
  'Draft a polite decline to a vendor proposal.',
  'Explain the difference between OKRs and KPIs for a new manager.',
  'Turn these rough notes into a short status update.',
  'Suggest three subject lines for the launch newsletter.',
  'Give me a checklist for running an effective retro.',
  'What questions should I ask a candidate for a senior analyst role?',
  'Turn this bullet list into a two-paragraph summary for the exec update.',
  'Draft an agenda for a 30-minute kickoff with a new client.',
  'How should I phrase a request for a deadline extension without sounding defensive?',
  'Proofread this and flag anything that reads as jargon.',
  'Give me five ways to open a customer renewal conversation.',
  'Write a short thank-you note to the team after the release.',
  'What are the risks of moving this project to a fixed-price contract?',
  'Condense these meeting notes into decisions and owners only.',
  'Help me explain the budget variance in plain language for the board pack.',
  'Draft a LinkedIn post announcing the partnership, no buzzwords.',
  'What should go in a one-page handover for someone covering my role for two weeks?',
  'Rewrite this Slack message so it sounds less abrupt.',
  'Give me a simple explanation of gross margin for a sales team.',
  'Suggest a fair way to split this workload across three people.',
  'What is a reasonable timeline for a supplier onboarding review?',
  'Turn this customer complaint into a ticket description with next steps.',
  'Draft the first paragraph of a case study about the migration project.',
  'What should I check before signing off a marketing spend request?',
  'Help me write a clear out-of-office message for two weeks of leave.',
  'List the questions a finance reviewer will ask about this forecast.',
  'Make this product description shorter and more concrete.',
  'How do I give feedback on a report that is thorough but too long?',
  'Draft a reminder to the team about the timesheet deadline.',
  'Summarise the pros and cons of renewing this software licence early.',
  'What is a good way to structure a weekly one-to-one?',
  'Turn this email thread into a short brief for my manager.',
  'Suggest a name for the internal tool that tracks supplier invoices.',
  'Help me prepare three questions for the vendor demo tomorrow.',
  'Rewrite this policy paragraph so a new starter would understand it.',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.query(`DELETE FROM chat_messages WHERE id LIKE $1`, [`${MARKER}%`]);
    console.log('[chat] cleared prior seed rows.');
    if (CLEAN_ONLY) { console.log('[chat] --clean complete.'); return; }

    const users = (await c.query(
      `SELECT id, department FROM users WHERE department IS NOT NULL AND TRIM(department) != ''`
    )).rows;

    let n = 0;
    for (const u of users) {
      const intensity = intensityFor(u.department);
      const quietRecently = isRecentlyQuiet(u.id, quietChanceFor(intensity));
      const activeChance = intensity === 'high' ? 0.55 : intensity === 'medium' ? 0.4 : 0.3;
      for (let daysAgo = N_DAYS; daysAgo >= 0; daysAgo--) {
        if (daysAgo <= 13 && quietRecently) continue; // same "gone quiet" cohort as the other scripts
        if (Math.random() > activeChance) continue; // most users don't use Chat every day
        // Each bucket is the 24 hours ENDING daysAgo days before now. The old
        // form anchored bucket 0 at `now` with zero width, so every one of
        // today's rows was stamped at the seeding minute and the Audit Log's
        // newest page was a wall of identical-time chat rows.
        const dayEnd = now - daysAgo * DAY;
        const dayStart = dayEnd - DAY;
        const nMsgs = rand(1, 3);
        const convId = uid('conv');
        for (let i = 0; i < nMsgs; i++) {
          const ts = dayStart + rand(0, Math.max(1, dayEnd - dayStart - 1));
          const text = pick(CHAT_PROMPTS);
          await c.query(
            `INSERT INTO chat_messages (id, conversation_id, user_id, prompt_text, prompt_length, occurred_at, ingested_at, source)
             VALUES ($1,$2,$3,$4,$5,$6,$6,'compliance')`,
            [uid('chat'), convId, u.id, text, text.length, ts]);
          n++;
        }
      }
    }
    console.log(`[chat] seeded ${n} chat_messages across ${users.length} users, trailing ${N_DAYS} days.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

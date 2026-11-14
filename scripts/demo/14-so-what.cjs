#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse So What: something on every card (lib/pulse/cowork/so-what.ts).
//
//   Hire or replace     Customer Success gets three more people who do mostly meaningful work and
//                       whose conversations end with an artifact, and three who do not and whose
//                       conversations produce nothing, so the two groups differ (hold, close the
//                       gap). Other teams answer as they are.
//   Recurring job       Four people in Finance do one kind of work no one in the team did, with no
//                       skill: some conversations as meaningful work and quicker, the rest slower.
//   Hardly used         Three people with one conversation two to three months ago and none since.
//   Key people          One person in the smallest team does enough meaningful work that two
//                       people hold most of the team's.
//   Roll out            A new way of working a manager confirmed in Finance, in work every team does.
//   Time freed          Three people in HR did one kind of work in long sessions two to three months
//                       ago and in short ones now.
//   Evenings            Five people in Product do enough of their AI work in the evening that the
//                       team stands out from the organisation, in the organisation's own timezone.
//   Decisions           One decision past its 30 days (it shows what happened since) and one waiting.
//
// Claude Chat conversations carry their own measured time (the gaps between prompts and replies)
// and whether a reply made an artifact, with its title, so the figures are measured the way real
// ones are.
//
// load.cjs runs this after every other sample script and takes these people's department away
// before the others run, so no other script gives them activity. People are upserted, never
// deleted; their rows are ff-sw- rows, cleared first.
//
//   docker compose exec hub node scripts/demo/14-so-what.cjs
//   docker compose exec hub node scripts/demo/14-so-what.cjs --clean
const { Client } = require('pg');
const { orgTimezone, workingTime } = require('./working-hours.cjs');

const SW = 'ff-sw-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const LEAD = 'team.lead@acmecorp.example';
const MODEL = 'claude-haiku-4-5-20251001';
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Titles of what a Claude Chat reply made, by kind of work, as the Compliance API gives them.
const TITLES = {
  structured_report: ['Q3 board report', 'Month-end variance commentary', 'Account health report'],
  analysis: ['Renewal risk analysis', 'Pipeline gap analysis', 'Churn drivers'],
  template_population: ['Onboarding pack', 'Supplier review form', 'Offer letter'],
  research_brief: ['Supplier pricing brief', 'Accruals research note'],
  synthesis: ['Customer feedback themes', 'Survey findings'],
  autonomous_workflow: ['Month-end checks summary'],
  basic_drafting: ['Reply draft'],
  summarisation: ['Call summary'],
};

const TEXT = {
  multi_file_operation: ['Apply the new cost-centre codes across all twelve budget workbooks.', 'Update the supplier name in every contract schedule in this folder.'],
  formatting: ['Reformat these twelve supplier statements into the ledger layout.', 'Tidy the formatting on this set of schedules.'],
  autonomous_workflow: ['Run the month-end checks across every cost centre and flag what fails.', 'Pull this week’s numbers from each tracker into the pack.'],
  transcription: ['Move these figures from the PDFs into the reconciliation sheet.', 'Copy the approved budgets into the planning tool.'],
  research_brief: ['Pull together a short brief on how our two biggest suppliers price their contracts.', 'Research how other firms handle quarter-end accruals and summarise.'],
  structured_report: ['Turn these figures into the month-end variance commentary.', 'Write up this quarter in the board report format.'],
  analysis: ['Work out which accounts are behind on renewal and why.', 'Compare this month to last and say what changed.'],
  basic_drafting: ['Draft a short reply to this email.', 'Reword this paragraph so it reads more clearly.'],
  summarisation: ['Summarise this call transcript into actions.', 'Summarise these notes for the team.'],
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run this inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Clear this script's own prior rows, child before parent.
    const like = `${SW}%`;
    await c.query(`DELETE FROM decision_log WHERE card LIKE 'work.%' AND decided_by = $1`, [LEAD]);
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM chat_assistant_meta WHERE id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_session_stats WHERE session_id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_sessions WHERE id LIKE $1`, [like]);
    if (CLEAN_ONLY) { console.log('[so-what] cleared.'); return; }

    const dept = `COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
    const teams = (await c.query(
      `SELECT DISTINCT ${dept} AS d FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
        WHERE u.email LIKE '%@acmecorp.example' AND u.id NOT LIKE 'ff-coach-%' AND u.id NOT LIKE $1 AND ${dept} IS NOT NULL ORDER BY 1`,
      [like])).rows.map(r => r.d);
    const team = (name) => (teams.includes(name) ? name : null);

    let seq = 0;
    const nextId = (kind) => `${SW}${kind}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    const person = async (slug, first, last, department) => {
      const id = `${SW}${slug}`;
      await c.query(`INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at)
        VALUES ($1, $2, $3, $4, 'agent', $5, $5)
        ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, department = EXCLUDED.department`,
        [id, `${first.toLowerCase()}.${last.toLowerCase()}@acmecorp.example`, `${first} ${last}`, department, now]);
      await c.query(`INSERT INTO admin_users (id, email, password_hash, display_name, role, department, linked_cowork_user_id, sso_enabled)
        VALUES ($1, $2, '__otel_pending__', $3, 'pulse', $4, $1, 0)
        ON CONFLICT (id) DO UPDATE SET department = EXCLUDED.department`,
        [id, `${id}@ff-pending.invalid`, `${first} ${last}`, department]);
      return id;
    };
    // A Claude Chat conversation: each prompt graded, each reply recorded (never its text), and the
    // last reply making an artifact when the conversation produced something. Its time is measured
    // from the gaps between these, as Command Centre measures real ones.
    // Conversations start in working hours, as real ones mostly do; the evenings step says otherwise.
    const workTime = workingTime(await orgTimezone(c));
    const chat = async (userId, startAt, prompts, produced, gapS, keepTime = false) => {
      const at = keepTime ? startAt : workTime(startAt);
      const sid = nextId('c');
      let ts = at;
      const ids = [];
      for (const [i, p] of prompts.entries()) {
        const id = nextId('m');
        ids.push(id);
        const text = pick(TEXT[p.kind] || TEXT.basic_drafting);
        await c.query(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, content_full, occurred_at, ingested_at)
          VALUES ($1, $2, $3, 'cowork_user_message', 'chat', 'compliance', $4, $4, $5, $6)`, [id, sid, userId, text, ts, now]);
        await c.query(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
          VALUES ($1, $2, $3, $4, 0.9, $5, $6)`, [id, userId, p.tier, p.kind, MODEL, ts + 30]);
        const last = i === prompts.length - 1;
        const made = last && produced ? pick(TITLES[p.kind] || TITLES.basic_drafting) : null;
        await c.query(`INSERT INTO chat_assistant_meta (id, conversation_id, user_id, model, artifacts_count, generated_files_count, output_names, occurred_at, ingested_at)
          VALUES ($1, $2, $3, 'claude-sonnet-4-6', $4, 0, $5, $6, $7)`, [nextId('r'), sid, userId, last && produced ? 1 : 0, made, ts + rand(30, 90), now]);
        ts += gapS;
      }
      await c.query(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at, created_at)
        VALUES ($1, $1, $2, 'compliance', $3, $4) ON CONFLICT (id) DO NOTHING`, [sid, userId, at, now]);
      return ids;
    };
    const daysAgo = (lo, hi) => now - rand(lo, hi) * DAY - rand(0, 8 * 3600);
    const done = [];

    // Hire or replace: a gap in Customer Success.
    const gapTeam = team('Customer Success') || teams[0];
    if (gapTeam) {
      const deep = [['Imogen', 'Hartley'], ['Callum', 'Reid'], ['Freya', 'Lindqvist']];
      const shallow = [['Rohan', 'Desai'], ['Beatrix', 'Moss'], ['Dmitri', 'Volkov']];
      for (const [i, [f, l]] of deep.entries()) {
        const id = await person(`deep-${i + 1}`, f, l, gapTeam);
        for (let k = 0; k < 40; k++) {
          await chat(id, daysAgo(1, 28), [{ tier: 3, kind: 'structured_report' }, { tier: 2, kind: 'analysis' }, { tier: 2, kind: 'structured_report' }], true, rand(240, 600));
        }
      }
      for (const [i, [f, l]] of shallow.entries()) {
        const id = await person(`shallow-${i + 1}`, f, l, gapTeam);
        for (let k = 0; k < 8; k++) {
          await chat(id, daysAgo(1, 28), [{ tier: 1, kind: 'basic_drafting' }, { tier: 1, kind: 'summarisation' }], false, rand(120, 400));
        }
      }
      done.push(`a gap in ${gapTeam}`);
    }

    // A recurring job in Finance, in a kind of work no one in the team did, with no skill.
    const jobTeam = team('Finance') || teams[1];
    let rolloutUser = null;
    if (jobTeam) {
      // A job only counts when none of the team's sessions of that kind used a skill, so pick a kind
      // the team has done without one, the least done first, and not one the Team Coaching people do
      // (13-team-coaching.cjs), or the boxes they fill would change.
      const kinds = (await c.query(
        `SELECT pc.task_type, COUNT(*) AS n,
                BOOL_OR(EXISTS (SELECT 1 FROM cowork_skill_invocations s WHERE s.session_id = cm.session_id)) AS skilled
           FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE ${dept} = $1 AND cm.occurred_at >= $2 GROUP BY 1`, [jobTeam, now - 30 * DAY])).rows;
      const coachKinds = new Set((await c.query(
        `SELECT DISTINCT pc.task_type FROM pulse_classifications pc
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE pc.user_id LIKE 'ff-coach-%' AND ${dept} = $1`, [jobTeam])).rows.map(r => r.task_type));
      const doneKinds = new Map(kinds.map(r => [r.task_type, { n: Number(r.n), skilled: r.skilled === true }]));
      const kind = ['multi_file_operation', 'formatting', 'autonomous_workflow', 'transcription', 'research_brief', 'analysis', 'summarisation', 'synthesis', 'template_population', 'process_substitution', 'structured_report']
        .filter(k => !doneKinds.get(k)?.skilled && !coachKinds.has(k))
        .sort((a, b) => (doneKinds.get(a)?.n ?? 0) - (doneKinds.get(b)?.n ?? 0))[0];
      if (!kind) console.log(`[so-what] every kind of work in ${jobTeam} used a skill somewhere, so its recurring job card stays empty.`);
      const workers = [['Saoirse', 'Byrne'], ['Tobias', 'Klein'], ['Amara', 'Okafor'], ['Nikhil', 'Rao']];
      for (const [i, [f, l]] of workers.entries()) {
        const id = await person(`job-${i + 1}`, f, l, jobTeam);
        if (i === 0) rolloutUser = id;
        // The first two do it as meaningful work, quicker; the other two as single answers, slower.
        const asWhole = i < 2;
        for (let k = 0; k < (kind ? 3 : 0); k++) {
          await chat(id, daysAgo(2, 26), [{ tier: asWhole ? 2 : 1, kind }, { tier: asWhole ? 3 : 1, kind }, { tier: asWhole ? 2 : 1, kind }], false, asWhole ? rand(240, 330) : rand(900, 1200));
        }
      }
      if (kind) done.push(`a recurring job (${kind}) in ${jobTeam}`);
    }

    // Hardly used: one conversation two to three months ago, none since.
    const rare = [['Greta', 'Holm'], ['Ezra', 'Whitlock'], ['Rosalind', 'Achebe']];
    for (const [i, [f, l]] of rare.entries()) {
      const id = await person(`rare-${i + 1}`, f, l, teams[(i * 3) % teams.length]);
      await chat(id, daysAgo(60, 80), [{ tier: 1, kind: 'basic_drafting' }], false, 120);
    }
    done.push('three people who have hardly used it');

    // Key people: in the team with the least meaningful work, one more person does enough that
    // they and the team's busiest hold most of it.
    const deepRows = (await c.query(
      `SELECT ${dept} AS d, pc.user_id, COUNT(*) AS n FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
         LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
        WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.surface IN ('cowork', 'chat') AND cm.occurred_at >= $1
          AND ${dept} IS NOT NULL
        GROUP BY 1, 2`, [now - 30 * DAY])).rows;
    const byTeam = new Map();
    for (const r of deepRows) {
      const t = byTeam.get(r.d) || { total: 0, top: 0 };
      t.total += Number(r.n);
      t.top = Math.max(t.top, Number(r.n));
      byTeam.set(r.d, t);
    }
    const keyTeam = [...byTeam.entries()].filter(([d]) => d !== gapTeam && d !== jobTeam).sort((a, b) => a[1].total - b[1].total)[0];
    if (keyTeam) {
      const [d, t] = keyTeam;
      // (busiest + x) / (total + x) >= 0.65, rounded up, in conversations of ten prompts.
      const x = Math.min(600, Math.max(10, Math.ceil((0.65 * t.total - t.top) / 0.35)));
      const id = await person('key-1', 'Felix', 'Brandt', d);
      for (let k = 0; k < Math.ceil(x / 10); k++) {
        await chat(id, daysAgo(1, 28), Array.from({ length: 10 }, (_, j) => ({ tier: j % 3 === 0 ? 3 : 2, kind: 'analysis' })), k % 3 === 0, rand(180, 420));
      }
      done.push(`a key person in ${d}`);
    }

    // Time freed: one kind of work in HR, in long sessions two to three months ago and short ones now.
    const timeTeam = team('HR') || teams[3];
    if (timeTeam) {
      const used = (await c.query(
        `SELECT pc.task_type, COUNT(*) AS n FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE ${dept} = $1 AND cm.occurred_at >= $2 GROUP BY 1`, [timeTeam, now - 90 * DAY])).rows;
      const coach = new Set((await c.query(
        `SELECT DISTINCT pc.task_type FROM pulse_classifications pc LEFT JOIN users u ON u.id = pc.user_id
           LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE pc.user_id LIKE 'ff-coach-%' AND ${dept} = $1`, [timeTeam])).rows.map(r => r.task_type));
      const n = new Map(used.map(r => [r.task_type, Number(r.n)]));
      // The kind the team does least, so its own sessions barely move the two averages.
      const kind = ['template_population', 'research_brief', 'synthesis', 'structured_report', 'analysis']
        .filter(k => !coach.has(k)).sort((x, y) => (n.get(x) ?? 0) - (n.get(y) ?? 0))[0];
      const workers = [['Hazel', 'Pryce'], ['Ingrid', 'Solberg'], ['Tamsin', 'Greaves']];
      for (const [i, [f, l]] of workers.entries()) {
        const id = await person(`time-${i + 1}`, f, l, timeTeam);
        for (let k = 0; k < 3; k++) {
          await chat(id, daysAgo(63, 87), [{ tier: 2, kind }, { tier: 2, kind }, { tier: 2, kind }], k === 0, rand(1000, 1150));
          await chat(id, daysAgo(2, 26), [{ tier: 2, kind }, { tier: 2, kind }, { tier: 2, kind }], k === 0, rand(240, 320));
        }
      }
      done.push(`time freed on ${kind} in ${timeTeam}`);
    }

    // Evenings: five people in Product do enough of their AI work out of hours that the team stands out.
    const lateTeam = team('Product') || teams[4];
    if (lateTeam) {
      const tz = (await c.query(`SELECT value FROM config WHERE key = 'telemetry_silence_timezone'`)).rows[0]?.value || 'Europe/London';
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
      const late = (t) => {
        const parts = fmt.formatToParts(new Date(t * 1000));
        const wd = parts.find(p => p.type === 'weekday')?.value;
        const h = Number(parts.find(p => p.type === 'hour')?.value);
        return wd === 'Sat' || wd === 'Sun' || h < 7 || h >= 19;
      };
      const rows = (await c.query(
        `SELECT ${dept} AS d, cm.occurred_at FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE pc.classifier_status = 'classified' AND cm.surface IN ('cowork', 'chat') AND cm.occurred_at >= $1`, [now - 30 * DAY])).rows;
      let teamAll = 0, teamLate = 0, orgAll = 0, orgLate = 0;
      for (const r of rows) {
        const l = late(Number(r.occurred_at));
        orgAll++; if (l) orgLate++;
        if (r.d === lateTeam) { teamAll++; if (l) teamLate++; }
      }
      // Add evening prompts until the team is at least a quarter out of hours and well over twice
      // the organisation, which moves with it.
      // Never more than half the team's own work again: if that cannot do it (the organisation is
      // itself mostly out of hours), the card stays empty rather than the team being buried.
      let x = 0;
      const ok = () => (teamLate + x) / (teamAll + x) >= 0.25 && (teamLate + x) / (teamAll + x) >= 2.5 * ((orgLate + x) / (orgAll + x));
      const cap = Math.ceil(teamAll / 2);
      while (!ok() && x < cap) x += 10;
      if (!ok()) {
        console.log(`[so-what] ${Math.round((100 * orgLate) / Math.max(orgAll, 1))}% of the organisation's sample work is already out of hours, so no team can stand out: the evenings card stays empty.`);
        x = 0;
      }
      const members = (await c.query(
        `SELECT u.id FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
          WHERE ${dept} = $1 AND u.email LIKE '%@acmecorp.example' AND u.id NOT LIKE 'ff-%' ORDER BY u.id LIMIT 5`, [lateTeam])).rows.map(r => r.id);
      // A weekday evening, 7pm to 11pm in the organisation's timezone.
      const evening = () => {
        for (;;) {
          const t = now - rand(1, 28) * DAY + rand(-12, 12) * 3600;
          const parts = fmt.formatToParts(new Date(t * 1000));
          const wd = parts.find(p => p.type === 'weekday')?.value;
          const h = Number(parts.find(p => p.type === 'hour')?.value);
          if (wd !== 'Sat' && wd !== 'Sun' && h >= 19 && h <= 22) return t;
        }
      };
      for (let k = 0; members.length && k < x / 5; k++) {
        await chat(members[k % members.length], evening(), Array.from({ length: 5 }, () => ({ tier: 2, kind: 'analysis' })), k % 4 === 0, rand(180, 420), true);
      }
      if (x > 0) done.push(`${x} evening prompts in ${lateTeam} (${tz})`);
    }

    // Roll out: a new way of working confirmed in Finance, in work every team does.
    if (rolloutUser) {
      const [msgId] = await chat(rolloutUser, daysAgo(22, 24), [{ tier: 3, kind: 'structured_report' }], true, 120);
      await c.query(`INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at, confirmed_at, confirmed_by)
        VALUES ($1, 'capability_creation', 'confirmed', 'Month-end variance commentary', 'Turns the month-end figures into the variance commentary in the house format.', $2, 3, $3, $4, $5)`,
        [rolloutUser, msgId, now - 22 * DAY, now - 20 * DAY, LEAD]);
      done.push('a confirmed new way of working in Finance');
    }

    // Decisions: one past its 30 days, so it shows what happened since, and one waiting.
    await c.query(`INSERT INTO decision_log (card, department, recommended, chosen, headline, figures_json, note, decided_by, decided_at, look_again_at)
      VALUES ('work.expand', 'Everyone', 'go', 'go', 'Give AI to the next wave of people.', $1, 'Next wave starts in January.', $2, $3, $4)
      ON CONFLICT DO NOTHING`,
      [JSON.stringify({ measure: { label: 'Weeks for half a wave to get there', value: 6.8, unit: ' weeks', lowerIsBetter: true } }), LEAD, now - 35 * DAY, now - 5 * DAY]);
    await c.query(`INSERT INTO decision_log (card, department, recommended, chosen, headline, figures_json, note, decided_by, decided_at, look_again_at)
      VALUES ('work.rarely_used', 'Everyone', 'go', 'go', 'Decide what to do about the people who have hardly used it.', $1, 'Asking each manager first.', $2, $3, $4)
      ON CONFLICT DO NOTHING`,
      [JSON.stringify({ measure: { label: 'People who have hardly used it', value: 5, unit: '', lowerIsBetter: true } }), LEAD, now - 5 * DAY, now + 25 * DAY]);
    done.push('two decisions, one past its 30 days');

    console.log(`[so-what] ${done.join('; ')}.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

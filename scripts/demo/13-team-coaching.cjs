#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Team Coaching: something in every box of both Team Coaching pages, for every team.
//
// Each team gets two more people: one who uses it a lot but nearly always for single answers
// (stuck), and one who started three to four weeks ago (a new starter). The new starter is the
// only person in the team doing one kind of work, and three people repeat another kind with no
// skill behind it. Developer Pulse gets the same in Claude Code sessions, with "Writing or fixing
// tests" as the repeated kind.
//
// load.cjs runs this after every other sample script, and takes these people's department away
// before the others run, so no other script gives them activity: each pattern only shows when
// these people have just the activity written here. People are upserted, never deleted, so
// nothing that refers to them breaks on a re-run; their sessions and prompts are ff-coach- rows,
// cleared first.
//
//   docker compose exec hub node scripts/demo/13-team-coaching.cjs
//   docker compose exec hub node scripts/demo/13-team-coaching.cjs --clean
//
// --clean only clears these rows. load.cjs runs it before the other scripts, so none of them
// finds last load's Team Coaching sessions and adds to them.
const { Client } = require('pg');
const { orgTimezone, workingTime } = require('./working-hours.cjs');

const COACH = 'ff-coach-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run this inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Clear this script's own prior rows, child before parent.
    const like = `${COACH}%`;
    await c.query(`DELETE FROM code_session_classifications WHERE session_id LIKE $1`, [like]);
    await c.query(`DELETE FROM code_session_stats WHERE session_id LIKE $1`, [like]);
    await c.query(`DELETE FROM pulse_classifications WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM pulse_skill_runs WHERE cowork_message_id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_session_stats WHERE session_id LIKE $1`, [like]);
    await c.query(`DELETE FROM cowork_sessions WHERE id LIKE $1`, [like]);
    if (CLEAN_ONLY) { console.log('[coaching] cleared.'); return; }

    const dept = `COALESCE(NULLIF(au.department, ''), NULLIF(u.department, ''))`;
    // Their Work Pulse sessions start in working hours, as real ones mostly do.
    const workTime = workingTime(await orgTimezone(c));
    const teams = (await c.query(
      `SELECT DISTINCT ${dept} AS d FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
        WHERE u.email LIKE '%@acmecorp.example' AND u.id NOT LIKE $1 AND ${dept} IS NOT NULL ORDER BY 1`, [like])).rows.map(r => r.d);
    const NAMES = [['Jordan', 'Avery'], ['Priya', 'Nair'], ['Tomas', 'Reyes'], ['Hannah', 'Lowe'], ['Kofi', 'Mensah'],
      ['Elena', 'Varga'], ['Marcus', 'Bell'], ['Aisha', 'Rahman'], ['Liam', 'Doyle'], ['Mei', 'Lin'], ['Noah', 'Fischer'],
      ['Sofia', 'Marino'], ['Ethan', 'Price'], ['Ruth', 'Okonjo'], ['Owen', 'Walsh'], ['Ines', 'Duarte']];
    // Kinds of work the classifier uses that the sample teams rarely do, for the one-person and repeated boxes,
    // rarest across the organisation first. Command Centre's grader goes on grading sample prompts after this
    // runs, so the rarest kind is the least likely to turn up again in the same team. Multi-file operation comes
    // first: the grader has not given it to any sample prompt. Transcription and autonomous workflow come last:
    // it gives those to some of the sample's alert and follow-up prompts (04-alerts.cjs, 01b-follow-up-2.cjs).
    const rarity = new Map((await c.query(
      `SELECT pc.task_type, COUNT(*) AS n FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
        WHERE cm.occurred_at >= $1 GROUP BY 1`, [now - 90 * DAY])).rows.map(r => [r.task_type, Number(r.n)]));
    const SPARE_KINDS = ['multi_file_operation', 'formatting', 'autonomous_workflow', 'transcription']
      .sort((a, b) => (rarity.get(a) ?? 0) - (rarity.get(b) ?? 0));
    const TEXT = {
      multi_file_operation: ['Apply the new cost-centre codes across all twelve budget workbooks.', 'Update the supplier name in every contract schedule in this folder.'],
      transcription: ['Transcribe this call recording into clean notes.', 'Turn this voice memo into written notes.'],
      autonomous_workflow: ['Run the weekly status roll-up across the team trackers.', 'Pull this week’s numbers from the tracker into the template.'],
      formatting: ['Tidy the formatting on this document.', 'Format this table to the house style.'],
      basic_drafting: ['Draft a short reply to this email.', 'Write a two-line update for the team channel.', 'Reword this paragraph so it reads more clearly.', 'Draft a meeting invite for Thursday.'],
    };
    const MODEL = 'claude-haiku-4-5-20251001';
    let seq = 0;
    const nextId = (kind) => `${COACH}${kind}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    const workSession = async (userId, at) => {
      const sid = nextId('s');
      await c.query(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at, created_at)
        VALUES ($1, $1, $2, 'otel', $3, $4) ON CONFLICT (id) DO NOTHING`, [sid, userId, at, now]);
      return sid;
    };
    const workPrompt = async (userId, sessionId, at, kind, tier) => {
      const id = nextId('m');
      const text = pick(TEXT[kind] || TEXT.basic_drafting);
      await c.query(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, content_full, occurred_at, ingested_at)
        VALUES ($1, $2, $3, 'cowork_user_message', 'cowork', 'otel', $4, $4, $5, $6)`, [id, sessionId, userId, text, at, now]);
      await c.query(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
        VALUES ($1, $2, $3, $4, 0.9, $5, $6)`, [id, userId, tier, kind, MODEL, at + 30]);
    };
    // models: the model the session ran on, recorded as the Hub records it, or none.
    const codeSession = async (userId, at, kind, tier, mins, model = null) => {
      const sid = nextId('c');
      const models = model
        ? JSON.stringify({ [model]: { input: rand(8000, 40000), output: rand(1500, 9000), cache_creation: 0, cache_read: rand(10000, 120000) } })
        : '{}';
      await c.query(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, commit_count, active_secs, skills_json, models_json, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, '[]', $9, $10)`, [sid, userId, at, at + mins * 60, rand(2, 6), rand(4, 12), rand(5, 30), mins * 60, models, now]);
      await c.query(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
        VALUES ($1, $2, $3, $4, 0.85, $5, 'classified', $6)`, [sid, userId, kind, tier, MODEL, at + mins * 60]);
    };

    for (const [i, team] of teams.entries()) {
      const slug = team.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const [sf, sl] = NAMES[(2 * i) % NAMES.length];
      const [nf, nl] = NAMES[(2 * i + 1) % NAMES.length];
      const stuck = `${COACH}stuck-${slug}`;
      const fresh = `${COACH}new-${slug}`;
      for (const [id, first, last] of [[stuck, sf, sl], [fresh, nf, nl]]) {
        await c.query(`INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at)
          VALUES ($1, $2, $3, $4, 'agent', $5, $5)
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, department = EXCLUDED.department`,
          [id, `${first.toLowerCase()}.${last.toLowerCase()}@acmecorp.example`, `${first} ${last}`, team, now]);
        // The same linkage row 01-organisation.cjs gives everyone with a department.
        await c.query(`INSERT INTO admin_users (id, email, password_hash, display_name, role, department, linked_cowork_user_id, sso_enabled)
          VALUES ($1, $2, '__otel_pending__', $3, 'pulse', $4, $1, 0)
          ON CONFLICT (id) DO UPDATE SET department = EXCLUDED.department`,
          [id, `${id}@ff-pending.invalid`.toLowerCase(), `${first} ${last}`, team]);
      }
      // Kinds the team has not done in the last 30 days: one for the new starter alone, one to repeat.
      const doneKinds = new Set((await c.query(
        `SELECT DISTINCT pc.task_type FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE ${dept} = $1 AND cm.occurred_at >= $2`, [team, now - 30 * DAY])).rows.map(r => r.task_type));
      const unused = SPARE_KINDS.filter(k => !doneKinds.has(k));
      const soloKind = unused[0];
      // A team that already does every spare kind repeats one it does, if none of its sessions used a skill.
      const withSkill = new Set((await c.query(
        `SELECT DISTINCT pc.task_type FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
           LEFT JOIN users u ON u.id = pc.user_id LEFT JOIN admin_users au ON au.linked_cowork_user_id = pc.user_id
          WHERE ${dept} = $1 AND cm.occurred_at >= $2
            AND EXISTS (SELECT 1 FROM cowork_skill_invocations s WHERE s.session_id = cm.session_id)`,
        [team, now - 30 * DAY])).rows.map(r => r.task_type));
      const repeatKind = unused[1] ?? SPARE_KINDS.find(k => k !== soloKind && !withSkill.has(k));
      const colleague = (await c.query(
        `SELECT u.id FROM users u LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
          WHERE ${dept} = $1 AND u.email LIKE '%@acmecorp.example' AND u.id NOT LIKE $2 ORDER BY u.id LIMIT 1`,
        [team, like])).rows[0]?.id;

      // The stuck person has used it for over two months, so they are not a new starter too.
      {
        const at = workTime(now - rand(60, 70) * DAY);
        const sid = await workSession(stuck, at);
        for (let j = 0; j < 3; j++) await workPrompt(stuck, sid, at + j * 120, 'basic_drafting', 1);
        await codeSession(stuck, now - rand(60, 70) * DAY, 'exploration', 1, rand(10, 40));
      }
      // Work Pulse. Stuck: 21 prompts over the last four weeks, all but one a single answer.
      for (let k = 0; k < 7; k++) {
        const at = workTime(now - rand(1, 27) * DAY - rand(0, 8 * 3600));
        const sid = await workSession(stuck, at);
        for (let j = 0; j < 3; j++) await workPrompt(stuck, sid, at + j * 120, 'basic_drafting', k === 0 && j === 0 ? 2 : 1);
      }
      // New starter: first prompt 24 days ago, ten prompts of work nobody else in the team does.
      for (let k = 0; k < 5; k++) {
        const at = workTime(now - (24 - k * 5) * DAY);
        const sid = await workSession(fresh, at);
        for (let j = 0; j < 2; j++) await workPrompt(fresh, sid, at + j * 120, soloKind || 'basic_drafting', j === 0 ? 2 : 1);
      }
      // Repeated with no skill: three people, three prompts each, in sessions that used no skill.
      if (repeatKind && colleague) {
        for (const who of [stuck, fresh, colleague]) {
          const at = workTime(now - rand(2, 20) * DAY);
          const sid = await workSession(who, at);
          for (let j = 0; j < 3; j++) await workPrompt(who, sid, at + j * 180, repeatKind, 1);
        }
      }

      // Developer Pulse. Stuck: single-step sessions, on the most costly model. New starter: first session 20 days ago.
      for (let k = 0; k < 8; k++) await codeSession(stuck, now - rand(1, 27) * DAY, 'exploration', k === 0 ? 2 : 1, rand(10, 40), 'claude-opus-4-8');
      for (let k = 0; k < 5; k++) await codeSession(fresh, now - (20 - k * 4) * DAY, 'feature', k % 2 ? 2 : 1, rand(20, 60));
      // Writing or fixing tests, repeated by three people with no skill.
      for (const who of colleague ? [stuck, fresh, colleague] : [stuck, fresh]) {
        for (let k = 0; k < 3; k++) await codeSession(who, now - rand(2, 20) * DAY, 'testing', 1, rand(15, 45));
      }
      if (!soloKind || !repeatKind) console.log(`[coaching] ${team} already does the spare kinds of work, so its ${!soloKind ? 'one-person' : 'repeated'} box stays empty.`);
    }
    console.log(`[coaching] a stuck person and a new starter in each of ${teams.length} teams, with work only one person does and work repeated with no skill.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Follow-up demo populator for a demo install. Builds on 01-organisation.cjs
// (which fixed the admin_users dept-linkage gap and gave every dept/user base
// Cowork+Developer Pulse activity). This pass fixes specific gaps found by live
// inspection after that first run:
//
//   1. Sam Taylor's OWN admin_users row had linked_cowork_user_id set to a
//      value that matches no real users.id —
//      every "My Pulse" card for that account was resolving to nothing. Root cause of
//      the empty dashboard/Delegation/Frontier/Milestone screenshots.
//   2. users.last_seen_at was never bumped by the first seed, so the
//      dashboard's Department Adoption heatmap (active_users = last_seen_at
//      within 7 days) read 0% everywhere.
//   3. The classifier rubric changed — Delegation View's "then vs
//      now" only has the 2 weeks since then to work with. Pushed that one
//      rubric version back (after the PRIOR version, well before "now") so
//      the current segment has enough history. This only affects chart
//      readability on this demo instance — the rubric content itself is untouched.
//   4. Cowork spend (cowork_messages, message_type='cowork_api_request') was
//      $32 across 23/65 users in the last 7 days — added real volume for all 65.
//   5. Frontier push / capability creation / skills & connectors — broadened
//      across users and given to Sam Taylor specifically.
//   6. GitHub overlay — no GitHub token is needed
//      itself and has synced zero stats. Added fabricated github_repo_map/
//      github_repo_stats/github_user_repo_stats rows for the department repo
//      names already used in code_session_stats, so the Shipping Alignment
//      chart + per-repo cards render without needing that sync fixed.
//   7. Developer Pulse Journey Grid — topped up code_session_classifications in
//      the trailing 6 weeks (the grid's exact window) for every user.
//
// Additive rows are `ff2-`-prefixed; re-running clears + reinserts them first.
// Structural fixes (1-3) are idempotent UPDATEs, safe to re-run.
//
// Usage: docker compose exec hub node scripts/demo/01b-follow-up-2.cjs [--clean]
const { Client } = require('pg');

const MARKER = 'ff2-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const WEEK = 7 * DAY;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

// Deterministic per-user "gone quiet recently" decision — MUST match
// 01-organisation.cjs/-v5.cjs exactly (same formula) so all three scripts
// agree on the same users every run. See the comment on this function in
// 01-organisation.cjs for why: independent Math.random() gates per script
// compound into near-100% "someone touched them recently" even when each
// individual gate looks conservative in isolation.
function isRecentlyQuiet(userId, chance) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000 < chance;
}
function quietChanceFor(intensity) {
  return intensity === 'high' ? 0.1 : intensity === 'medium' ? 0.25 : 0.4;
}

const CODE_INTENSITY = { Engineering: 'high', Enablement: 'high', Platform: 'high', Data: 'high', AppliedAI: 'high', Product: 'medium' };
const intensityFor = (dept) => CODE_INTENSITY[dept] || 'low';

const REPO_BY_DEPT = {
  Engineering: 'platform-core', Product: 'platform-core', Enablement: 'internal-tools',
  Finance: 'finance-scripts', HR: 'people-ops-tools', Legal: 'legal-automation',
  Marketing: 'marketing-tools', Sales: 'sales-tools', 'Customer Success': 'cs-tools',
};
const GITHUB_ORG = 'acme-corp';

const MODELS_WEIGHTED = [['claude-opus-4-8', 2], ['claude-sonnet-4-6', 6], ['claude-haiku-4-5', 3]];
const weightedModel = () => pick(MODELS_WEIGHTED.flatMap(([m, w]) => Array(w).fill(m)));
const RATES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
function priceUsd(model, input, output) {
  const r = RATES[model];
  return (input * r.in + output * r.out) / 1_000_000;
}

const SKILLS = ['code-review', 'writing-plans', 'systematic-debugging', 'doc-coauthoring', 'meeting-notes', 'internal-comms', 'brand-guidelines'];
const MCP_SERVERS = [['github', 'search_repos'], ['slack', 'post_message'], ['salesforce', 'query_records'], ['linear', 'list_issues'], ['google-drive', 'search_files']];

// Novel one-off task-type slugs so "First X task" reads as genuinely new
// territory, distinct from the recurring commodity task types already seeded.
const FRONTIER_TASK_TYPES = [
  'multi_repo_refactor', 'customer_escalation_synthesis', 'contract_clause_extraction',
  'board_pack_automation', 'candidate_pipeline_analysis', 'churn_root_cause_analysis',
  'vendor_contract_negotiation_prep', 'cross_team_incident_review', 'pricing_model_simulation',
  'competitive_teardown', 'regulatory_filing_draft', 'sales_territory_optimisation',
  'onboarding_flow_redesign', 'data_migration_planning', 'brand_voice_audit',
];
// Varied phrasing for each user's frontier-push anchor message — a single
// hardcoded string here was flagged as repeated verbatim across every
// spotlighted user (same defect fixed in 02-your-account.cjs), so every
// anchor now gets a different, task-specific line.
const ANCHOR_TEMPLATES = [
  (label) => `First real attempt at ${label} — no template to follow yet.`,
  (label) => `Tried ${label} for the first time this week.`,
  (label) => `Took a first pass at ${label} ahead of the review.`,
  (label) => `Worked through ${label} end to end without a playbook.`,
  (label) => `Stepped outside the usual routine to handle ${label}.`,
  (label) => `Explored ${label} while prepping for the exec update.`,
  (label) => `Kicked off ${label} — new territory this quarter.`,
  (label) => `Ran ${label} solo for the first time, no prior example to copy.`,
  (label) => `Gave ${label} a proper first attempt instead of punting it.`,
  (label) => `Handled ${label} directly rather than routing it elsewhere.`,
];

function mondayUtcStart(tsSec) {
  const d = new Date(tsSec * 1000);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
  return Math.floor(monday / 1000);
}
function dateStr(tsSec) {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run this inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();

  const now = Math.floor(Date.now() / 1000);

  try {
    // ── 0. Clear this script's own prior rows (FK-safe) ─────────────────────
    await c.query(`DELETE FROM code_session_classifications WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM pulse_events WHERE cowork_message_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_skill_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_mcp_invocations WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_otel_metrics WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_session_stats WHERE session_id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM code_assistant_meta WHERE id LIKE $1`, [`${MARKER}%`]);
    const mimicRepoNames = [...new Set(Object.values(REPO_BY_DEPT))];
    await c.query(`DELETE FROM github_user_repo_stats WHERE repo = ANY($1)`, [mimicRepoNames]);
    await c.query(`DELETE FROM github_repo_stats WHERE repo = ANY($1)`, [mimicRepoNames]);
    await c.query(`DELETE FROM github_repo_map WHERE repo = ANY($1)`, [mimicRepoNames]);
    console.log('[fullflow-v2] cleared prior seed rows (incl. mimicked GitHub overlay rows).');

    if (CLEAN_ONLY) {
      console.log('[fullflow-v2] --clean complete (structural fixes 1-3 are left in place — they correct real bugs/gaps, not demo filler).');
      return;
    }

    // ── 1. Fix Sam Taylor's broken linked_cowork_user_id ─────────────────────
    const samFix = await c.query(
      `UPDATE admin_users SET linked_cowork_user_id = 'sam.taylor@example.com'
       WHERE email = 'sam.taylor@example.com' AND linked_cowork_user_id != 'sam.taylor@example.com'`);
    console.log(`[fullflow-v2] checked the Sam Taylor account's admin link (${samFix.rowCount} row updated).`);

    // ── 2. All target users (every department + Sam Taylor specifically) ────
    const usersRes = await c.query(
      `SELECT id, display_name, department FROM users WHERE department IS NOT NULL AND TRIM(department) != ''`);
    const users = usersRes.rows;
    const sam = { id: 'sam.taylor@example.com', display_name: 'Sam Taylor', department: 'Enablement' };
    // A fresh installation may have no Sam Taylor account: add it only where it exists.
    const samExists = (await c.query('SELECT 1 FROM users WHERE id = $1', [sam.id])).rowCount > 0;
    const allUsers = samExists ? [...users, sam] : users;
    console.log(`[fullflow-v2] ${allUsers.length} target users${samExists ? ' (incl. the Sam Taylor account)' : ''}.`);

    // ── 3. users.last_seen_at — no more blanket bump, see step 5 ───────────
    // Removed: this used to force last_seen_at to "within the last 3 days"
    // for literally every user, unconditionally — which is exactly why the
    // dashboard Adoption heatmap read 100% for every department (it's
    // active_users/total_users where active = last_seen_at within 7 days)
    // and the 14-day trend line looked flat (every day, every user counted
    // as active). last_seen_at is now only ever set from REAL generated
    // activity — v1 sets it from its own weekly-presence-gated data, and the
    // per-day activity gate below does the same for whatever this script adds.
    console.log('[fullflow-v2] last_seen_at is derived from real activity only (no blanket bump) — see step 5.');

    // ── 4. Push the rubric-version boundary back so Delegation View has ────
    // enough post-change history. Only touches the LATEST version, and only
    // far enough back to stay safely after the PRIOR version.
    const versions = (await c.query(`SELECT id, changed_at FROM pulse_rubric_versions ORDER BY changed_at DESC`)).rows;
    if (versions.length > 0) {
      // pg returns bigint columns as strings — Number() them before arithmetic
      // (string + number is concatenation, not addition, and produced a
      // garbage out-of-range epoch on the first attempt).
      const latest = { id: versions[0].id, changed_at: Number(versions[0].changed_at) };
      const prior = versions[1] ? { changed_at: Number(versions[1].changed_at) } : null;
      const target = now - 7 * WEEK;
      const floor = prior ? prior.changed_at + DAY : 0;
      const newChangedAt = Math.max(target, floor);
      await c.query(`UPDATE pulse_rubric_versions SET changed_at = $1 WHERE id = $2`, [newChangedAt, latest.id]);
      console.log(`[fullflow-v2] moved rubric version ${latest.id} back to ${new Date(newChangedAt * 1000).toISOString()} — Delegation View's current segment now has enough weeks.`);
    }

    // ── 5. Cowork + Code spend — real volume, all users, last 7 days (+ a
    // lighter continuing trail across the last 8 weeks so it isn't a cliff) ──
    // NOTE on realism: nReq API-request rows for a given (user, day) share
    // ONE session_id — they used to each get their own unique session_id,
    // which is the dominant reason "sessions/week" read as 2,000+ across the
    // org (COUNT DISTINCT session_id ≈ message count). A day's worth of API
    // calls from one sitting is one real session. Also: NOT every user is
    // active every day any more (activeToday gate) — every user having spend
    // every single day, unconditionally, was the other half of both the
    // heatmap-100% and the inflated-session-count problems.
    let coworkApiN = 0, coworkSpend = 0, codeMetaN = 0;
    const lastActivityByUser = {};
    for (const u of allUsers) {
      const intensity = intensityFor(u.department);
      const activeChance = intensity === 'high' ? 0.8 : intensity === 'medium' ? 0.6 : 0.4;
      // Same deterministic decision as 01-organisation.cjs/-v5.cjs — a
      // "gone quiet recently" user gets no activity here in the trailing
      // ~13 days either, so all three scripts agree and this genuinely
      // shows up as a real gap instead of being masked by this script's own
      // independent daily dice roll.
      const quietRecently = isRecentlyQuiet(u.id, quietChanceFor(intensity));
      for (let daysAgo = 55; daysAgo >= 0; daysAgo--) {
        const inLast7 = daysAgo <= 7;
        if (daysAgo <= 13 && quietRecently) continue;
        if (!inLast7 && Math.random() < 0.55) continue; // sparser trail before the last week
        if (Math.random() > activeChance) continue; // this user was quiet this particular day
        const dayStart = now - daysAgo * DAY;
        // Cap "today" at `now`, never the full day — an uncapped rand(0, DAY-1)
        // for daysAgo===0 can land hours/a day in the future (found live: newest
        // rows were dated a full day ahead of `now`). v1 already handled this
        // correctly; this was the same bug v3 later worked around for the
        // Journey Grid without ever fixing it here at the source.
        const dayEnd = daysAgo === 0 ? now : dayStart + DAY;

        // Cowork API requests — grouped under one session for the day.
        const nReq = inLast7 ? rand(2, 6) : rand(0, 2);
        const daySessionId = uid('capisess');
        for (let i = 0; i < nReq; i++) {
          const ts = dayStart + rand(0, Math.max(1, dayEnd - dayStart - 1));
          const model = weightedModel();
          const input = rand(2000, 25000), output = rand(300, 4000);
          const cost = priceUsd(model, input, output);
          coworkSpend += cost; coworkApiN++;
          await c.query(
            `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, model, cost_usd, content_preview, occurred_at, ingested_at)
             VALUES ($1,$2,$3,'cowork_api_request','cowork','otel',$4,$5,$6,$7,$7)`,
            [uid('capi'), daySessionId, u.id, model, cost.toFixed(6), `${model} | {"input_tokens":${input},"output_tokens":${output}}`, ts]);
          if (ts > (lastActivityByUser[u.id] ?? 0)) lastActivityByUser[u.id] = ts;
        }

        // Code spend top-up — intensity-gated, heavier in the last 7 days.
        const codeChance = intensity === 'high' ? 0.9 : intensity === 'medium' ? 0.6 : 0.3;
        if (inLast7 && Math.random() < codeChance) {
          const model = weightedModel();
          const input = rand(3000, 20000), output = rand(500, 3500);
          const ts = dayStart + rand(0, Math.max(1, dayEnd - dayStart - 1));
          await c.query(
            `INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, error_count, cwd, git_branch, occurred_at, ingested_at, commit_count, source, query_source)
             VALUES ($1,$2,$3,$4,$5,$6,0,$7,'end_turn',$8,0,$9,'main',$10,$10,0,'otel','main')`,
            [uid('capm'), u.id, `ff2-topup-${u.id}-${daysAgo}`, model, input, output, rand(3000, 40000), rand(1, 5), `/repos/${REPO_BY_DEPT[u.department] || 'internal-tools'}`, ts]);
          codeMetaN++;
          if (ts > (lastActivityByUser[u.id] ?? 0)) lastActivityByUser[u.id] = ts;
        }
      }
    }
    // Only push last_seen_at forward for users who actually got activity in
    // this pass — never overwrite a more recent value v1 (or a prior pass)
    // already set, and never touch users with no activity here at all.
    let lastSeenBumped = 0;
    for (const [userId, ts] of Object.entries(lastActivityByUser)) {
      const r = await c.query(
        `UPDATE users SET last_seen_at = $1 WHERE id = $2 AND (last_seen_at IS NULL OR last_seen_at < $1)`,
        [ts, userId]);
      lastSeenBumped += r.rowCount;
    }
    console.log(`[fullflow-v2] spend: cowork_api_request=${coworkApiN} (~$${coworkSpend.toFixed(2)}), code_assistant_meta top-up=${codeMetaN}, last_seen_at advanced for ${lastSeenBumped} users.`);

    // ── 6. Frontier push / capability creation / skills & connectors ────────
    // Spread across a good chunk of users (not literally everyone — matches
    // the real feature's rarity), plus Sam Taylor explicitly.
    const spotlightUsers = [...(samExists ? [sam] : []), ...allUsers.filter(u => u.id !== sam.id).sort(() => Math.random() - 0.5).slice(0, 28)];
    let eventN = 0, skillN = 0, mcpN = 0;
    let frontierIdx = 0;
    for (const u of spotlightUsers) {
      // Anchor a small cowork message so each event has a real cowork_message_id.
      const anchorId = uid('anchor');
      const anchorTs = now - rand(0, 10 * DAY);
      const taskSlug = FRONTIER_TASK_TYPES[frontierIdx % FRONTIER_TASK_TYPES.length];
      frontierIdx++;
      const taskLabel = taskSlug.replace(/_/g, ' ');
      const article = /^[aeiou]/i.test(taskLabel) ? 'an' : 'a';
      const anchorText = pick(ANCHOR_TEMPLATES)(taskLabel);
      await c.query(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, surface, source, occurred_at, ingested_at)
         VALUES ($1,$1,$2,'cowork_user_message','user',$3,'cowork','otel',$4,$4)`,
        [anchorId, u.id, anchorText, anchorTs]);

      const tier = rand(2, 3);
      await c.query(
        `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
         VALUES ($1,'frontier_push','confirmed',$2,$3,$4,$5,$6)`,
        [u.id, `First ${taskLabel} task`, `You ran ${article} ${taskLabel} for the first time — a new type of work entering your delegation range.`, anchorId, tier, anchorTs]);
      eventN++;

      if (Math.random() < 0.4) {
        await c.query(
          `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
           VALUES ($1,'tier_3_first','confirmed','First Tier 3 task',$2,$3,3,$4)`,
          [u.id, 'Your first frontier-level delegation — autonomous work that pushes beyond what you\'ve delegated before.', anchorId, anchorTs - rand(0, 5 * DAY)]);
        eventN++;
      }
      if (Math.random() < 0.35) {
        const previewSnippet = pick(['Draft the board pack variance commentary end to end.', 'Reconcile the vendor spend ledger and flag anomalies.', 'Build the new-hire onboarding flow across three systems.']);
        await c.query(
          `INSERT INTO pulse_events (user_id, event_type, status, title, body, cowork_message_id, tier, detected_at)
           VALUES ($1,'capability_creation','candidate',$2,$3,$4,3,$5)`,
          [u.id, `New capability — ${taskLabel}`, `Tier 3 session flagged as a potential new capability. Prompt: "${previewSnippet}"`, anchorId, anchorTs - rand(0, 3 * DAY)]);
        eventN++;
      }

      // Skills & connectors — last 7 days.
      const nSkills = rand(1, 3);
      for (let i = 0; i < nSkills; i++) {
        await c.query(
          `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, invocation_type, surface, source)
           VALUES ($1,$2,$3,$4,$5,$6,'cowork','otel')`,
          [uid('skill'), u.id, anchorId, pick(SKILLS), now - rand(0, 7 * DAY), Math.random() < 0.5 ? 'agent_chained' : 'user_typed']);
        skillN++;
      }
      const nMcp = rand(1, 2);
      for (let i = 0; i < nMcp; i++) {
        const [server, tool] = pick(MCP_SERVERS);
        await c.query(
          `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, surface, source)
           VALUES ($1,$2,$3,$4,$5,$6,'cowork','otel')`,
          [uid('mcp'), u.id, anchorId, server, tool, now - rand(0, 7 * DAY)]);
        mcpN++;
      }
    }
    console.log(`[fullflow-v2] milestones: pulse_events=${eventN}, skill_invocations=${skillN}, mcp_invocations=${mcpN} across ${spotlightUsers.length} users${samExists ? ' (incl. the Sam Taylor account)' : ''}.`);

    // ── 7. GitHub overlay — mimic without a GitHub token or sync ───────
    const repoNames = [...new Set(Object.values(REPO_BY_DEPT))];
    for (const repo of repoNames) {
      await c.query(
        `INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES ($1,$2,$3) ON CONFLICT (repo) DO NOTHING`,
        [repo, `${GITHUB_ORG}/${repo}`, now]);
    }
    const usersByRepo = {};
    for (const u of allUsers) {
      const repo = REPO_BY_DEPT[u.department] || 'internal-tools';
      (usersByRepo[repo] ||= []).push(u);
    }
    let ghRepoStatN = 0, ghUserStatN = 0;
    for (const repo of repoNames) {
      const repoUsers = usersByRepo[repo] || [];
      const intensity = intensityFor(Object.keys(REPO_BY_DEPT).find(d => REPO_BY_DEPT[d] === repo) || 'default');
      for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
        if (intensity === 'low' && Math.random() < 0.5) continue;
        const date = dateStr(now - daysAgo * DAY);
        const dayCommits = intensity === 'high' ? rand(2, 9) : intensity === 'medium' ? rand(1, 5) : rand(0, 3);
        if (dayCommits === 0) continue;
        const prs = Math.random() < 0.3 ? 1 : 0;
        await c.query(
          `INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (repo, date) DO UPDATE SET commit_count = EXCLUDED.commit_count, prs_merged = EXCLUDED.prs_merged, synced_at = EXCLUDED.synced_at`,
          [repo, date, dayCommits, prs, now]);
        ghRepoStatN++;

        // Distribute the day's commits across this repo's users.
        let remaining = dayCommits;
        const shuffled = [...repoUsers].sort(() => Math.random() - 0.5);
        for (const u of shuffled) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, rand(1, 3));
          await c.query(
            `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (user_id, repo, date) DO UPDATE SET commit_count = EXCLUDED.commit_count, synced_at = EXCLUDED.synced_at`,
            [u.id, repo, date, take, now]);
          ghUserStatN++;
          remaining -= take;
        }
      }
    }
    console.log(`[fullflow-v2] GitHub overlay (mimicked, no PAT needed): ${repoNames.length} repos mapped, github_repo_stats=${ghRepoStatN}, github_user_repo_stats=${ghUserStatN}.`);

    // ── 8. Developer Pulse Journey Grid — top up the exact 6-week window ────────
    const CODE_TASK_TYPES = ['bug_investigation', 'feature_build', 'code_review', 'documentation', 'refactor'];
    let journeySessN = 0;
    for (const u of allUsers) {
      const intensity = intensityFor(u.department);
      const repo = REPO_BY_DEPT[u.department] || 'internal-tools';
      for (let weeksAgo = 5; weeksAgo >= 0; weeksAgo--) {
        // Ensure near-full weekly coverage (not probability-gated) so the grid reads as a real journey.
        if (intensity === 'low' && Math.random() < 0.2) continue;
        const wStart = mondayUtcStart(now) - weeksAgo * WEEK;
        // Cap the current week at `now`, never the full week — see the
        // matching fix + comment on the spend loop above.
        const wEnd = weeksAgo === 0 ? now : wStart + WEEK;
        const ts = wStart + rand(0, Math.max(1, wEnd - wStart - 1));
        const trendP = (5 - weeksAgo) / 5;
        const tier = Math.random() < 0.25 + 0.45 * trendP ? (Math.random() < 0.3 + 0.3 * trendP ? 3 : 2) : 1;
        const model = weightedModel();
        const input = rand(3000, 22000), output = rand(400, 3500);
        const sessionId = uid('jsess');
        const metaId = uid('jmeta');
        await c.query(
          `INSERT INTO code_assistant_meta (id, user_id, session_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, error_count, cwd, git_branch, occurred_at, ingested_at, commit_count, source, query_source)
           VALUES ($1,$2,$3,$4,$5,$6,0,$7,'end_turn',$8,0,$9,'main',$10,$10,$11,'otel','main')`,
          [metaId, u.id, sessionId, model, input, output, rand(2000, 30000), rand(1, 6), `/repos/${repo}`, ts, tier === 3 ? 1 : 0]);
        await c.query(
          `INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, tool_use_count, error_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, models_json, skills_json, mcp_json, commit_count, computed_at)
           VALUES ($1,$2,$3,'main',$4,$4,1,1,$5,0,$6,$7,0,0,$8,'[]','[]',$9,$4)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId, u.id, repo, ts, rand(1, 6), input, output, JSON.stringify({ [model]: { input, output, cache_creation: 0, cache_read: 0 } }), tier === 3 ? 1 : 0]);
        await c.query(
          `INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
           VALUES ($1,$2,$3,$4,$5,'claude-haiku-4-5-20251001','classified',$6)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId, u.id, pick(CODE_TASK_TYPES), tier, 0.78 + Math.random() * 0.18, ts]);
        journeySessN++;
      }
    }
    console.log(`[fullflow-v2] Developer Pulse Journey Grid: ${journeySessN} classified sessions across the trailing 6 weeks, all ${allUsers.length} users.`);

    // ── 9. Reset aggregator cursors so rolling snapshots recompute ─────────
    for (const key of ['pulse_aggregator_last_run', 'pulse_aggregator_daily_last_run', 'code_aggregator_last_run']) {
      await c.query(`INSERT INTO config (key, value) VALUES ($1, '') ON CONFLICT (key) DO UPDATE SET value = ''`, [key]);
    }
    console.log('[fullflow-v2] aggregator cursors reset — rolling snapshots recompute within ~60s.');
    console.log('[fullflow-v2] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Ties the sample's GitHub commits to how its people actually work.
//
// The sample's GitHub rows were invented independently of the Code classifier's
// tiers (see github-tool-split.cjs), so on sample data the people who hand whole
// pieces of work over ship no more than the people who do not. Every So what
// hiring card therefore reads "approve the hires", and the standard-job cards
// carry the page on their own. That is a fault in the sample, not in the page:
// the page is reporting the sample honestly.
//
// This rescales each person's existing commit counts so that, across the sample,
// the people who hand whole work over ship meaningfully more per person than the
// people who do not, with enough spread that some of the second group still beat
// some of the first. Repos, dates and the Claude/Codex/no-tool split keep their
// shape: only how many commits sit on each row changes.
//
// Idempotent: a person's target is computed from their delegation depth, never
// from their current commit count, so running it twice gives the same answer.
// Run by load.cjs AFTER github-tool-split.cjs. Pass { write: false } to report
// what it would do without changing anything.

const DAY = 86400;
const WINDOW_DAYS = 30;
/** Commits a month a middling person makes in the sample. */
const BASE_COMMITS = 6;
/** More than this share of a person's sessions in the top two tiers and they hand whole work over. */
const DEEP_PERSON_SHARE = 0.5;
/** Fewer sessions than this in the window and a person is in neither group. */
const HARDLY_USED_SESSIONS = 2;

/** A stable number in [0,1) from a string, so a re-run lands on the same spread. */
function hashUnit(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** How many commits a month this person should make, given how they work. */
function targetCommits(userId, group) {
  const spread = hashUnit(userId);
  // Deep people average about twice the shallow ones, but the ranges overlap, so
  // the chart never reads as two clean blocks and an outlier stays visible.
  const multiplier = group === 'deep' ? 1.3 + spread * 1.6 : 0.6 + spread * 0.9;
  return Math.max(1, Math.round(BASE_COMMITS * multiplier));
}

async function tieGithubToDepth(db, { write = true, nowS = Math.floor(Date.now() / 1000) } = {}) {
  const since = nowS - WINDOW_DAYS * DAY;

  const people = (await db.query(`
    SELECT csc.user_id,
           COUNT(*) AS sessions,
           SUM(CASE WHEN csc.tier >= 2 THEN 1 ELSE 0 END) AS deep
    FROM code_session_classifications csc
    JOIN code_session_stats css ON css.session_id = csc.session_id
    WHERE csc.status = 'classified' AND css.last_at >= $1
    GROUP BY csc.user_id`, [since])).rows;

  const groupOf = new Map();
  for (const p of people) {
    const sessions = Number(p.sessions);
    const deep = Number(p.deep);
    if (sessions < HARDLY_USED_SESSIONS) continue;
    groupOf.set(p.user_id, deep / sessions > DEEP_PERSON_SHARE ? 'deep' : 'shallow');
  }

  const rows = (await db.query(
    `SELECT user_id, repo, date, commit_count, claude_commit_count, codex_commit_count, no_tool_commit_count
     FROM github_user_repo_stats WHERE date >= $1`,
    [new Date(since * 1000).toISOString().slice(0, 10)])).rows;

  const byUser = new Map();
  for (const r of rows) {
    if (!groupOf.has(r.user_id)) continue;
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }

  const report = { deep: { people: 0, commits: 0 }, shallow: { people: 0, commits: 0 }, rows: 0, skipped: rows.length - [...byUser.values()].flat().length };

  for (const [userId, theirRows] of byUser) {
    const group = groupOf.get(userId);
    const target = targetCommits(userId, group);
    const current = theirRows.reduce((a, r) => a + Number(r.commit_count), 0);
    if (current <= 0) continue;

    // Spread the target over the person's existing rows in proportion to what is
    // already there, so their repos and days keep the shape the sample gave them.
    let left = target;
    for (let i = 0; i < theirRows.length; i++) {
      const r = theirRows[i];
      const share = Number(r.commit_count) / current;
      const want = i === theirRows.length - 1 ? left : Math.min(left, Math.max(0, Math.round(target * share)));
      left -= want;
      const scale = Number(r.commit_count) > 0 ? want / Number(r.commit_count) : 0;
      const claude = Math.min(want, Math.round(Number(r.claude_commit_count ?? 0) * scale));
      const codex = Math.min(want - claude, Math.round(Number(r.codex_commit_count ?? 0) * scale));
      const none = Math.max(0, want - claude - codex);
      if (write) {
        await db.query(
          `UPDATE github_user_repo_stats
             SET commit_count = $1, claude_commit_count = $2, codex_commit_count = $3, no_tool_commit_count = $4
           WHERE user_id = $5 AND repo = $6 AND date = $7`,
          [want, claude, codex, none, r.user_id, r.repo, r.date]);
      }
      report.rows++;
    }
    report[group].people++;
    report[group].commits += target;
  }

  const per = (g) => (g.people > 0 ? Math.round((g.commits / g.people) * 10) / 10 : null);
  return { ...report, deepPerPerson: per(report.deep), shallowPerPerson: per(report.shallow) };
}

module.exports = { tieGithubToDepth, targetCommits };

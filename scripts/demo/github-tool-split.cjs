// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Fills the GitHub tool split (migration 0047) on the sample's GitHub rows
// from the sample's own Claude Code and Codex commits, so Developer Pulse's
// Shipping alignment chart and GitHub repo figures show commits made with
// Claude Code, made with Codex and with no AI tool recorded.
//
// The real GitHub sync matches each commit to a tool commit by the same
// person within 15 minutes (lib/pulse/code/github-tool-match.ts). The
// sample's GitHub rows are daily counts with no commit times, invented apart
// from its Claude Code and Codex activity, so here each person's tool commits
// are matched to their GitHub commits on the nearest day, up to three days
// away, each tool commit to at most one GitHub commit. Claude Code commits
// come from the commit metric where the person has any, otherwise from their
// model calls, as in the sync. Commits on a repo not attributed to a person
// count as no AI tool recorded.
//
// Run by load.cjs after the ChatGPT and Codex activity. Pass { write: false }
// to report the split without changing anything.

const DAY = 86400;
const MAX_DAYS_APART = 3;

const dayNumber = (dateStr) => Math.round(Date.parse(`${dateStr}T00:00:00Z`) / 1000 / DAY);
const dayOf = (epochS) => Math.floor(Number(epochS) / DAY);

async function fillGithubToolSplit(db, { write = true } = {}) {
  const userRows = (await db.query(
    'SELECT user_id, repo, date, commit_count FROM github_user_repo_stats WHERE commit_count > 0')).rows;
  if (userRows.length === 0) return { claude: 0, codex: 0, none: 0, rows: 0 };
  const minDay = Math.min(...userRows.map((r) => dayNumber(r.date))) - MAX_DAYS_APART;
  const fromS = minDay * DAY;

  // Tool commits per person, one entry per commit, as day numbers.
  const tools = new Map();
  const forUser = (u) => { if (!tools.has(u)) tools.set(u, { claude: [], codex: [] }); return tools.get(u); };
  const push = (list, day, n) => { for (let i = 0; i < Math.min(Math.round(Number(n)), 1000); i++) list.push(day); };
  const metric = (await db.query(
    `SELECT user_id, occurred_at, value FROM code_otel_metrics
      WHERE metric_name = 'claude_code.commit.count' AND user_id IS NOT NULL AND value > 0 AND occurred_at >= $1`, [fromS])).rows;
  const metricUsers = new Set();
  for (const r of metric) { metricUsers.add(r.user_id); push(forUser(r.user_id).claude, dayOf(r.occurred_at), r.value); }
  const meta = (await db.query(
    `SELECT user_id, occurred_at, commit_count FROM code_assistant_meta
      WHERE commit_count > 0 AND user_id IS NOT NULL AND occurred_at >= $1`, [fromS])).rows;
  for (const r of meta) if (!metricUsers.has(r.user_id)) push(forUser(r.user_id).claude, dayOf(r.occurred_at), r.commit_count);
  const codex = (await db.query(
    'SELECT user_id, occurred_at, commit_count FROM codex_actions WHERE commit_count > 0 AND occurred_at >= $1', [fromS])).rows;
  for (const r of codex) push(forUser(r.user_id).codex, dayOf(r.occurred_at), r.commit_count);

  // Each person's GitHub commits, one slot per commit.
  const slotsByUser = new Map();
  for (const r of userRows) {
    if (!slotsByUser.has(r.user_id)) slotsByUser.set(r.user_id, []);
    for (let i = 0; i < Number(r.commit_count); i++) slotsByUser.get(r.user_id).push({ row: r, day: dayNumber(r.date), tool: null });
  }
  // Closest first, Claude Code before Codex on a tie.
  for (const [userId, slots] of slotsByUser) {
    const t = tools.get(userId);
    if (!t) continue;
    const pairs = [];
    for (const tool of ['claude', 'codex']) {
      t[tool].forEach((day, e) => slots.forEach((s, k) => {
        const gap = Math.abs(s.day - day);
        if (gap <= MAX_DAYS_APART) pairs.push({ gap, tool, e, k });
      }));
    }
    pairs.sort((a, b) => a.gap - b.gap || (a.tool === b.tool ? 0 : a.tool === 'claude' ? -1 : 1) || a.k - b.k || a.e - b.e);
    const used = { claude: new Set(), codex: new Set() };
    for (const p of pairs) {
      if (slots[p.k].tool || used[p.tool].has(p.e)) continue;
      slots[p.k].tool = p.tool;
      used[p.tool].add(p.e);
    }
  }

  // Counts per person-repo-day and per repo-day.
  const userSplit = new Map();
  const repoTool = new Map();
  for (const slots of slotsByUser.values()) {
    for (const s of slots) {
      const key = `${s.row.user_id}\u0000${s.row.repo}\u0000${s.row.date}`;
      const u = userSplit.get(key) || { claude: 0, codex: 0, none: 0 };
      u[s.tool || 'none']++;
      userSplit.set(key, u);
      const rk = `${s.row.repo}\u0000${s.row.date}`;
      const rt = repoTool.get(rk) || { claude: 0, codex: 0 };
      if (s.tool) rt[s.tool]++;
      repoTool.set(rk, rt);
    }
  }
  const repoRows = (await db.query('SELECT repo, date, commit_count FROM github_repo_stats')).rows;
  const totals = { claude: 0, codex: 0, none: 0, rows: 0 };
  for (const r of repoRows) {
    const rt = repoTool.get(`${r.repo}\u0000${r.date}`) || { claude: 0, codex: 0 };
    const claude = Math.min(rt.claude, Number(r.commit_count));
    const codexN = Math.min(rt.codex, Number(r.commit_count) - claude);
    const none = Number(r.commit_count) - claude - codexN;
    totals.claude += claude; totals.codex += codexN; totals.none += none; totals.rows++;
    if (write) {
      await db.query(
        `UPDATE github_repo_stats SET claude_commit_count = $3, codex_commit_count = $4, no_tool_commit_count = $5
          WHERE repo = $1 AND date = $2`, [r.repo, r.date, claude, codexN, none]);
    }
  }
  if (write) {
    // Person rows with no commits (none written by the sample) still get a split of zeros.
    await db.query(
      `UPDATE github_user_repo_stats SET claude_commit_count = 0, codex_commit_count = 0, no_tool_commit_count = commit_count
        WHERE commit_count <= 0`);
    for (const [key, s] of userSplit) {
      const [userId, repo, date] = key.split('\u0000');
      await db.query(
        `UPDATE github_user_repo_stats SET claude_commit_count = $4, codex_commit_count = $5, no_tool_commit_count = $6
          WHERE user_id = $1 AND repo = $2 AND date = $3`, [userId, repo, date, s.claude, s.codex, s.none]);
    }
  }
  return totals;
}

module.exports = { fillGithubToolSplit };

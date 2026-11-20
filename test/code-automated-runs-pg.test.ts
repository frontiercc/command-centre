// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Automated runs on Postgres: a burst of one-prompt sessions from one person is labelled by rule,
// without a model call, shows as its own kind of work, and stays out of the figures about people.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { markAutomatedRuns, AUTOMATED_WORK_TYPE, AUTOMATED_MIN_SESSIONS } = await import('@/lib/pulse/code/automated-runs');
    const { getCoachingFigures } = await import('@/lib/pulse/code/coaching-figures');
    const { getOutputGroups } = await import('@/lib/pulse/code/output-groups');
    const { getTypedClient } = await import('@/lib/db/client');
    const nowS = Math.floor(Date.now() / 1000);
    const day = nowS - 2 * 86400;

    for (const [id, dept] of [['bot', 'Lab'], ['ann', 'Lab'], ['ben', 'Lab'], ['cat', 'Lab'], ['dan', 'Lab'], ['eve', 'Lab'], ['fay', 'Lab']]) {
      await sql.run(`INSERT INTO users (id, email, display_name, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, `${id}@example.com`, id, dept, day, day]);
    }
    const session = async (id: string, user: string, firstAt: number, prompts: number, commits = 0) => {
      await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, active_secs, commit_count, computed_at)
                     VALUES (?, ?, ?, ?, ?, 5, ?, ?)`, [id, user, firstAt, firstAt + 30, prompts, commits, nowS]);
    };
    const classify = async (id: string, user: string, workType: string, tier: number) => {
      await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
                     VALUES (?, ?, ?, ?, 0.9, 'test', 'classified', ?)`, [id, user, workType, tier, nowS]);
    };

    // A harness: the minimum burst inside one hour, one prompt each. Half were already classified.
    for (let i = 0; i < AUTOMATED_MIN_SESSIONS; i++) {
      await session(`bot-${i}`, 'bot', day + i * 120, 1);
      if (i % 2 === 0) await classify(`bot-${i}`, 'bot', 'other', 1);
    }
    // One short of the burst from someone else: their own quick questions, never labelled.
    for (let i = 0; i < AUTOMATED_MIN_SESSIONS - 1; i++) {
      await session(`ann-q${i}`, 'ann', day + i * 120, 1);
      await classify(`ann-q${i}`, 'ann', 'exploration', 1);
    }
    // A long run of multi-prompt sessions inside an hour is a person working, not a harness.
    for (let i = 0; i < AUTOMATED_MIN_SESSIONS + 2; i++) {
      await session(`ben-${i}`, 'ben', day + i * 60, 4);
      await classify(`ben-${i}`, 'ben', 'feature', 2);
    }

    const client = await getTypedClient();
    const labelled = await markAutomatedRuns(client, nowS, 1800);
    expect(labelled).toBe(AUTOMATED_MIN_SESSIONS);

    const kinds = await sql.all<{ work_type: string; n: number }>(
      `SELECT work_type, COUNT(*) AS n FROM code_session_classifications WHERE user_id = 'bot' GROUP BY work_type`);
    expect(kinds).toEqual([{ work_type: AUTOMATED_WORK_TYPE, n: AUTOMATED_MIN_SESSIONS }]);
    const ann = await sql.all<{ work_type: string }>(`SELECT DISTINCT work_type FROM code_session_classifications WHERE user_id = 'ann'`);
    expect(ann).toEqual([{ work_type: 'exploration' }]);
    const ben = await sql.all<{ work_type: string }>(`SELECT DISTINCT work_type FROM code_session_classifications WHERE user_id = 'ben'`);
    expect(ben).toEqual([{ work_type: 'feature' }]);

    // Running it again changes nothing.
    expect(await markAutomatedRuns(client, nowS, 1800)).toBe(0);

    // Team coaching: the runs show as their own kind of work, labelled, but are not people's sessions.
    const lab = (await getCoachingFigures('all', nowS)).teams.find(t => t.department === 'Lab')!;
    const automated = lab.work.find(w => w.workType === AUTOMATED_WORK_TYPE)!;
    expect(automated.label).toBe('Automated runs');
    expect(automated.sessions).toBe(AUTOMATED_MIN_SESSIONS);
    expect(lab.sessions).toBe((AUTOMATED_MIN_SESSIONS - 1) + (AUTOMATED_MIN_SESSIONS + 2));
    expect(lab.people).toBe(2);

    // So what: the harness is in neither group; output is the commits in people's own sessions.
    for (const [user, commits] of [['cat', 3], ['dan', 2], ['eve', 0], ['fay', 1]] as const) {
      await session(`${user}-1`, user, day - 86400, 3, commits);
      await classify(`${user}-1`, user, 'feature', 1);
      await session(`${user}-2`, user, day - 86400 + 7200, 3, 0);
      await classify(`${user}-2`, user, 'bugfix', 1);
    }
    // Pull requests and accepted edits come from Claude Code's telemetry; the harness's are ignored.
    await sql.run(`INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, occurred_at)
                   VALUES ('m1', 'cat', 'cat-1', 'claude_code.pull_request.count', 2, NULL, ?),
                          ('m2', 'cat', 'cat-1', 'claude_code.code_edit_tool.decision', 5, 'accept', ?),
                          ('m3', 'cat', 'cat-1', 'claude_code.code_edit_tool.decision', 9, 'reject', ?),
                          ('m4', 'bot', 'bot-0', 'claude_code.pull_request.count', 50, NULL, ?)`, [day, day, day, day]);
    // Someone whose GitHub account is linked: their commits come from GitHub, not their sessions.
    const today = new Date((day) * 1000).toISOString().slice(0, 10);
    await sql.run(`INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES ('dan', 'org/app', ?, 7, ?)`, [today, nowS]);

    const g = (await getOutputGroups('all', nowS)).find(x => x.department === 'Lab')!;
    expect(g.people).toBe(6);
    expect(g.shallow.people).toBe(5);
    // cat 3 + dan 7 from GitHub (not their 2 from sessions) + eve 0 + fay 1.
    expect(g.shallow.commits).toBe(11);
    expect(g.shallow.prs).toBe(2);
    expect(g.shallow.edits).toBe(5);
    expect(g.fromGithub).toBe(1);
    expect(g.deep.people).toBe(1);
    expect(g.deep.prs).toBe(0);
  } finally {
    await cleanup();
  }
}

describe('Developer Pulse automated runs (postgres)', () => {
  it('labels a burst of one-prompt sessions by rule and keeps it out of the people figures', async () => {
    await runSpec();
  }, 180_000);
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse Team coaching on Postgres counts a Codex session's commits from its own actions
// (codex_actions), since Claude Code's telemetry, which fills code_session_stats.commit_count, never
// sees them. A long Codex session that committed is not "a long session that committed nothing".
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { getCoachingFigures } = await import('@/lib/pulse/code/coaching-figures');
    const nowS = Math.floor(Date.now() / 1000);
    const t = nowS - 2 * 86400;

    await sql.run(`INSERT INTO users (id, email, display_name, department, first_seen_at, last_seen_at) VALUES ('dev', 'dev@example.com', 'Dev', 'Engineering', ?, ?)`, [t, t]);
    const session = async (id: string) => {
      // An hour and a bit of measured work, and no commits as Claude Code's telemetry sees it.
      await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, active_secs, commit_count, computed_at)
                     VALUES (?, 'dev', ?, ?, 4000, 0, ?)`, [id, t - 4000, t, nowS]);
      await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
                     VALUES (?, 'dev', 'feature', 2, 0.9, 'test', 'classified', ?)`, [id, nowS]);
    };
    await session('cc-1');
    await session('codex:x');
    // The Codex session made two commits, recorded on its own actions.
    await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, commit_count, occurred_at) VALUES ('a1', 'dev', 'codex:x', 2, ?)`, [t]);

    const team = async (vendor: 'all' | 'claude' | 'openai') =>
      (await getCoachingFigures(vendor, nowS)).teams.find(x => x.department === 'Engineering')!;

    // Both long sessions; only the Claude Code one committed nothing.
    expect((await team('all')).longNothing).toEqual({ sessions: 1, long: 2, share: 0.5 });
    expect((await team('claude')).longNothing).toEqual({ sessions: 1, long: 1, share: 1 });
    expect((await team('openai')).longNothing).toEqual({ sessions: 0, long: 1, share: 0 });
    // Codex sends no edit decisions, so its view has no acceptance figure.
    expect((await team('openai')).editAcceptance).toBeNull();
  } finally {
    await cleanup();
  }
}

describe('Developer Team coaching with Codex (postgres)', () => {
  it('counts a Codex session\'s commits from its own actions', async () => {
    await runSpec();
  }, 180_000);
});

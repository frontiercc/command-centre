// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// So What's waves survive retention. Retention deletes the judged prompts (Work Pulse) and
// sessions (Developer Pulse) each person's first dates are read from; it now keeps those dates
// first (lib/pulse/first-dates.ts), so the waves read the same after it runs as before, in
// both retention modes. On a hub upgraded after retention had already deleted dates, a month
// that started before the dates were complete is left out rather than shown wrong. Erasure
// deletes the kept dates with the person.
import { describe, it, expect } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const DAY = 86400;
const PEOPLE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

/** A hub that has been keeping first dates for a year, so a wave 200 days ago can be measured. */
async function keptForAYear(nowS: number) {
  const { setConfigValue } = await import('@/lib/config');
  await setConfigValue('pulseFirstDatesWorkFrom', String(nowS - 365 * DAY));
  await setConfigValue('pulseFirstDatesCodeFrom', String(nowS - 365 * DAY));
}

async function seed(sql: TestSql, nowS: number, startedDaysAgo = 200) {
  let n = 0;
  const prompt = async (user: string, daysAgo: number, tier: number) => {
    const id = `m${startedDaysAgo}-${++n}`;
    const at = nowS - daysAgo * DAY;
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at)
      VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'otel', ?, ?)`, [id, `s-${id}`, user, `prompt ${id}`, at]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
      VALUES (?, ?, ?, 'drafting', 0.9, 'haiku', ?)`, [id, user, tier, at]);
  };
  const session = async (user: string, daysAgo: number, tier: number) => {
    const id = `code-${startedDaysAgo}-${++n}`;
    const at = nowS - daysAgo * DAY;
    await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, user_msg_count, tool_use_count, commit_count, computed_at)
      VALUES (?, ?, ?, ?, 1, 2, 0, ?)`, [id, user, at - 600, at, nowS]);
    await sql.run(`INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, classified_at)
      VALUES (?, ?, 'feature', ?, 0.9, 'haiku', ?)`, [id, user, tier, at]);
  };
  for (const [i, p] of PEOPLE.entries()) {
    const id = `${p}-${startedDaysAgo}`;
    await sql.run(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`, [id, `${id}@test.local`, id]);
    // Started startedDaysAgo (200: past the 90-day retention window); reached meaningful work 7 + i days later.
    await prompt(id, startedDaysAgo, 1);
    await prompt(id, startedDaysAgo - 7 - i, 2);
    await prompt(id, 5, 1);
    await session(id, startedDaysAgo, 1);
    await session(id, startedDaysAgo - 7 - i, 2);
    await session(id, 5, 1);
  }
}

async function waves(nowS: number) {
  const { getWorkFinds } = await import('@/lib/pulse/cowork/so-what-finds');
  const { getFinds } = await import('@/lib/pulse/code/so-what-finds');
  const empty = { rows: [], sessions: [], sessionsByUser: new Map<string, number>() };
  return {
    work: (await getWorkFinds('all', empty, undefined, nowS)).waves,
    code: (await getFinds('all', undefined, nowS)).waves,
  };
}

describe('So What waves after retention', () => {
  for (const mode of ['strip', 'purge'] as const) {
    it(`read the same after retention runs (${mode} mode)`, async () => {
      const { sql, cleanup } = await createTestDatabase();
      try {
        const { setConfigValue } = await import('@/lib/config');
        const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
        await setConfigValue('retentionMode', mode);
        const nowS = Math.floor(Date.now() / 1000);
        await keptForAYear(nowS);
        await seed(sql, nowS);

        const before = await waves(nowS);
        // One wave of six on each page, starting 200 days ago.
        expect(before.work).toHaveLength(1);
        expect(before.work[0]).toMatchObject({ people: 6, reached: 6 });
        expect(before.code).toHaveLength(1);
        expect(before.code[0]).toMatchObject({ people: 6, reached: 6 });

        await runRetentionCleanup();
        // The old judged prompts and sessions are gone...
        const left = await sql.get<{ pc: number; css: number }>(
          `SELECT (SELECT COUNT(*) FROM pulse_classifications) AS pc, (SELECT COUNT(*) FROM code_session_stats) AS css`);
        expect(left).toEqual({ pc: 6, css: 6 });
        // ...and the waves read exactly as before.
        expect(await waves(nowS)).toEqual(before);

        // Running retention again keeps the same dates.
        await runRetentionCleanup();
        expect(await waves(nowS)).toEqual(before);
      } finally {
        await cleanup();
      }
    }, 120_000);
  }

  it('leaves out a month that started before the dates were complete, on a hub just upgraded', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // As migration 0057 left it: dates complete from the start of the 90-day window.
      const from = await sql.get<{ work: string; code: string }>(
        `SELECT (SELECT value FROM config WHERE key = 'pulse_first_dates_work_from') AS work,
                (SELECT value FROM config WHERE key = 'pulse_first_dates_code_from') AS code`);
      // Set when the database was migrated, which on a shared test server is when the run began.
      for (const v of [from!.work, from!.code]) {
        expect(Number(v)).toBeLessThanOrEqual(nowS - 90 * DAY);
        expect(Number(v)).toBeGreaterThan(nowS - 91 * DAY);
      }

      await seed(sql, nowS, 200);
      await seed(sql, nowS, 40);
      const w = await waves(nowS);
      const recentMonth = new Date((nowS - 40 * DAY) * 1000).toISOString().slice(0, 7);
      // Only the wave that started inside the window shows; the one from 200 days ago does not.
      expect(w.work.map(x => x.month)).toEqual([recentMonth]);
      expect(w.code.map(x => x.month)).toEqual([recentMonth]);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('erasure deletes the kept dates with the person', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
      const { deleteUserData } = await import('@/lib/db/queries');
      await seed(sql, Math.floor(Date.now() / 1000));
      await runRetentionCleanup();
      const kept = await sql.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM pulse_first_dates ORDER BY user_id`);
      expect(kept.map(r => r.user_id)).toEqual(PEOPLE.map(p => `${p}-200`));

      await deleteUserData('p1-200');
      const after = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pulse_first_dates WHERE user_id = 'p1-200'`);
      expect(after!.n).toBe(0);
      const others = await sql.get<{ n: number }>(`SELECT COUNT(DISTINCT user_id) AS n FROM pulse_first_dates`);
      expect(others!.n).toBe(5);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

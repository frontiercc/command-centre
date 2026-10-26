// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getPerson360: typeof import('@/lib/pulse/person').getPerson360;
let weekStarts: typeof import('@/lib/pulse/period').weekStarts;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const person = await import('@/lib/pulse/person');
  getPerson360 = person.getPerson360;

  const period = await import('@/lib/pulse/period');
  weekStarts = period.weekStarts;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_metrics;`);
  await sql.exec(`DELETE FROM code_metrics;`);
  await sql.exec(`DELETE FROM cowork_messages;`);
  await sql.exec(`DELETE FROM chat_messages;`);
  await sql.exec(`DELETE FROM users;`);
});

async function seedUser(id: string, displayName: string | null, department: string | null) {
  await sql.run(
    `INSERT INTO users (id, email, display_name, department) VALUES (?, ?, ?, ?)`,
    [id, `${id}@example.com`, displayName, department],
  );
}

describe('getPerson360', () => {
  it('assembles cowork, code, chat, combined spend, and weekly series for a fully-seeded user', async () => {
    await seedUser('u1', 'Ada Lovelace', 'Engineering');

    // Cowork: rolling user-scope pulse_metrics row
    await sql.run(
      `INSERT INTO pulse_metrics (
         scope_type, scope_id, period_start, period_end,
         dds, oti, tier_1_count, tier_2_count, tier_3_count,
         event_count, granularity, computed_at
       ) VALUES ('user', 'u1', ?, ?, 2.5, 1.8, 3, 5, 2, 10, 'rolling', ?)`,
      [NOW - 7 * 86400, NOW, NOW],
    );

    // Code: rolling user-scope code_metrics row
    await sql.run(
      `INSERT INTO code_metrics (
         scope_type, scope_id, period_start, period_end,
         spend_usd, session_count, commit_count, autonomy_ratio,
         active_time_user_s, active_time_cli_s, lines_added,
         edit_accept_count, edit_reject_count,
         input_tokens, output_tokens,
         granularity, computed_at
       ) VALUES ('user', 'u1', ?, ?, 12.5, 4, 6, 1.3, 3600, 1200, 250, 8, 2, 0, 0, 'rolling', ?)`,
      [NOW - 7 * 86400, NOW, NOW],
    );

    // Cowork spend: cowork_api_request rows in the 7-day window
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, cost_usd)
       VALUES ('m1', 's1', 'u1', 'cowork_api_request', ?, 3.25)`,
      [NOW - 1000],
    );

    // Chat: messages in the last 7 days
    await sql.run(
      `INSERT INTO chat_messages (id, user_id, prompt_text, prompt_length, occurred_at)
       VALUES ('c1', 'u1', 'hello', 5, ?)`,
      [NOW - 500],
    );
    await sql.run(
      `INSERT INTO chat_messages (id, user_id, prompt_text, prompt_length, occurred_at)
       VALUES ('c2', 'u1', 'world', 5, ?)`,
      [NOW - 400],
    );

    // Weekly series seed data (8 weeks of code_metrics + pulse_metrics week rows)
    const weeks = weekStarts(NOW, 8);
    for (const [i, ws] of weeks.entries()) {
      await sql.run(
        `INSERT INTO code_metrics (
           scope_type, scope_id, period_start, period_end, spend_usd,
           input_tokens, output_tokens, session_count, commit_count,
           granularity, computed_at
         ) VALUES ('user', 'u1', ?, ?, ?, 0, 0, 0, 0, 'week', ?)`,
        [ws, ws + 1, i + 1, NOW],
      );
      await sql.run(
        `INSERT INTO pulse_metrics (
           scope_type, scope_id, period_start, period_end, event_count,
           tier_1_count, tier_2_count, tier_3_count,
           granularity, computed_at
         ) VALUES ('user', 'u1', ?, ?, ?, 0, 0, 0, 'week', ?)`,
        [ws, ws + 1, i + 2, NOW],
      );
    }

    const result = await getPerson360('u1');

    expect(result.userId).toBe('u1');
    expect(result.displayName).toBe('Ada Lovelace');
    expect(result.department).toBe('Engineering');

    expect(result.cowork).toEqual({
      tierCounts: { t1: 3, t2: 5, t3: 2 },
      dds: 2.5,
      oti: 1.8,
    });

    expect(result.code).toEqual({
      spendUsd: 12.5,
      sessions: 4,
      commits: 6,
      autonomy: 1.3,
      engagedHours: (3600 + 1200) / 3600,
      linesAdded: 250,
      editAcceptRate: 8 / (8 + 2),
    });

    expect(result.chat).toEqual({ messages7d: 2 });

    expect(result.combinedSpend).toEqual({
      codeUsd: 12.5,
      coworkUsd: 3.25,
      totalUsd: 12.5 + 3.25,
    });
    expect(result.combinedSpend.totalIsPartial).toBeFalsy();

    expect(result.weekly.codeSpend).toHaveLength(8);
    expect(result.weekly.coworkEvents).toHaveLength(8);
  });

  it('returns null per-surface sections when a surface has no data, and null userId fields are handled', async () => {
    await seedUser('u2', null, null);
    // No pulse_metrics, no code_metrics, no cowork_messages, no chat_messages rows for u2.

    const result = await getPerson360('u2');

    expect(result.userId).toBe('u2');
    expect(result.displayName).toBeNull();
    expect(result.department).toBeNull();
    expect(result.cowork).toBeNull();
    expect(result.code).toBeNull();
    expect(result.chat).toEqual({ messages7d: 0 });

    expect(result.combinedSpend).toEqual({
      codeUsd: null,
      coworkUsd: 0,
      totalUsd: null,
    });
  });

  it('sets totalIsPartial when code spend is null but cowork spend is > 0', async () => {
    await seedUser('u3', 'Grace Hopper', 'Engineering');

    // Code metrics row present but spend_usd is null (unpriced model) — not a "no code" case.
    await sql.run(
      `INSERT INTO code_metrics (
         scope_type, scope_id, period_start, period_end,
         spend_usd, session_count, commit_count, autonomy_ratio,
         active_time_user_s, active_time_cli_s, lines_added,
         edit_accept_count, edit_reject_count,
         input_tokens, output_tokens,
         granularity, computed_at
       ) VALUES ('user', 'u3', ?, ?, NULL, 2, 1, 1.0, 100, 100, 10, 0, 0, 0, 0, 'rolling', ?)`,
      [NOW - 7 * 86400, NOW, NOW],
    );

    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, cost_usd)
       VALUES ('m2', 's2', 'u3', 'cowork_api_request', ?, 5.0)`,
      [NOW - 1000],
    );

    const result = await getPerson360('u3');

    expect(result.code?.spendUsd).toBeNull();
    expect(result.combinedSpend).toEqual({
      codeUsd: null,
      coworkUsd: 5.0,
      totalUsd: 5.0,
      totalIsPartial: true,
    });
  });

  it('totalUsd is null (not partial) when both code and cowork spend are absent/zero', async () => {
    await seedUser('u4', 'No Spend', 'Engineering');

    const result = await getPerson360('u4');
    expect(result.combinedSpend).toEqual({
      codeUsd: null,
      coworkUsd: 0,
      totalUsd: null,
    });
    expect(result.combinedSpend.totalIsPartial).toBeFalsy();
  });
});

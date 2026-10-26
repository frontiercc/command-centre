// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route test: GET /api/pulse/dept/[dept] returns the additive `coaching`
// field with dept coaching prompts (Spread Panel + Coaching
// Prompts). Harness copied verbatim from test/pulse-delegation-dept-route.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...mod,
    getAdminSession: vi.fn(async () => ({
      authenticated: true, role: 'admin', userId: 'admin-1',
      email: 'a@test.local', department: null,
    })),
  };
});

/** Shared DB seed: one confirmed Finance use case + Gina's qualifying activity.
 *  `enableFlag` controls whether `use_cases_enabled='true'` is written to the
 *  config table (getDeptCoachingPrompts itself must return [] without
 *  querying the DB when the flag is off; the route calls it unconditionally
 *  and relies on that internal gate). */
async function seedFixture(enableFlag: boolean, ackGina = false) {
  // A fully migrated Postgres database — every table the route reads
  // (pulse_metrics, use_cases, use_case_week_matches, coaching_acks, config,
  // ...) already exists. getDeptCoachingPrompts reads config's
  // use_cases_enabled first — returns [] immediately when it's not
  // 'true'. When it is, it also reads useCasesAtRiskQuietWeeks (hoisted to
  // one read for the whole call) for the quiet-window cutoff.
  // findSpreadCandidates (called by getDeptCoachingPrompts) reads
  // coaching_acks on every call.
  const { createTestDatabase } = await import('./helpers/db');
  const { client, sql, cleanup } = await createTestDatabase();

  const { schema } = await import('@/lib/db/schema');
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  if (enableFlag) {
    await sql.run(`INSERT INTO config (key, value, updated_at) VALUES ('use_cases_enabled', 'true', ?)`, [now]);
  }

  await db.insert(schema.users).values([
    { id: 'u-gina', email: 'gina@test.local', display_name: 'Gina', department: 'Finance' },
  ]);

  // One confirmed, signal-bearing use case matching Finance's structured_report work.
  await sql.run(`INSERT INTO use_cases
    (id, title, status, departments, task_types, keywords, skills, connectors,
     origin, capture_method, lifecycle, strategic, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['uc-1', 'Board-Pack Prep', 'confirmed', '["Finance"]', '["structured_report"]',
      '[]', '[]', '[]', 'planned', 'guided', 'not_seen', 0, now, now]);

  // Spread needs the use case's own skill, and
  // lists people whose sessions were JUDGED to be this work (weekly matches)
  // but who never ran the skill. Gina: three judged sessions in the last
  // completed week, no skill use.
  await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, model, generated_at, downloaded_at)
    VALUES ('uc-1', 'board-pack-prep', 'd', 'b', '[]', '{}', '{}', 'm', ?, ?)`, [now, now]);
  const { weekStart } = await import('@/lib/pulse/period');
  const lastWeek = weekStart(now) - 7 * DAY;
  for (let i = 0; i < 3; i++) {
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES ('uc-1', ?, 'u-gina', ?)`, [lastWeek, `gina-s${i}`]);
  }

  // An acked pair must vanish from the coaching field.
  if (ackGina) {
    await sql.run(`INSERT INTO coaching_acks (user_id, use_case_id, acked_by, acked_at)
      VALUES ('u-gina', 'uc-1', 'admin@test.local', ?)`, [now]);
  }

  return { client, cleanup };
}

describe('GET /api/pulse/dept/[dept] — coaching field', () => {
  it('returns a coaching prompt naming the user and the matching confirmed use case; delegation still present', async () => {
    const { cleanup } = await seedFixture(true);
    try {
      const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
      const res = await GET(
        new NextRequest('http://x/api/pulse/dept/Finance?weeks=13'),
        { params: Promise.resolve({ dept: 'Finance' }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.coaching.prompts).toHaveLength(1);
      expect(body.coaching.prompts[0].promptText).toContain('Gina');
      expect(body.coaching.prompts[0].promptText).toContain('Board-Pack Prep');
      // Additive contract — the sibling delegation field must still be present.
      expect(body.delegation).toBeDefined();
      expect(body.delegation.window).toBe(13);
    } finally {
      await cleanup();
    }
  });

  it('returns empty prompts (spread module short-circuits after a single config read) when useCasesEnabled is off (I2)', async () => {
    const { cleanup } = await seedFixture(false);
    try {
      const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
      const res = await GET(
        new NextRequest('http://x/api/pulse/dept/Finance?weeks=13'),
        { params: Promise.resolve({ dept: 'Finance' }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.coaching.prompts).toEqual([]);
      // Additive contract still holds even with coaching gated off.
      expect(body.delegation).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('returns empty prompts once Gina\'s (user, use case) pair has been acknowledged', async () => {
    const { cleanup } = await seedFixture(true, true);
    try {
      const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
      const res = await GET(
        new NextRequest('http://x/api/pulse/dept/Finance?weeks=13'),
        { params: Promise.resolve({ dept: 'Finance' }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.coaching.prompts).toEqual([]);
      expect(body.delegation).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

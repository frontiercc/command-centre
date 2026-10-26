// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const DAY = 86400;
const NOW = 1_790_000_000; // fixed clock

describe('buildCorpusFromRows (pure)', () => {
  it('scrubs, orders oldest-first, labels people A/B/C, marks follow-ups, collapses duplicates and counts', async () => {
    const { buildCorpusFromRows } = await import('@/lib/usecases/skill-corpus');
    const rows = [
      { user_id: 'u-b', session_id: 's2', content_full: 'variance commentary please, rows below', occurred_at: NOW - 2 * DAY },
      { user_id: 'u-a', session_id: 's1', content_full: 'draft the month-end variance commentary', occurred_at: NOW - 10 * DAY },
      { user_id: 'u-a', session_id: 's1', content_full: 'no - one paragraph per line. send to me not james.l@example.com', occurred_at: NOW - 10 * DAY + 60 },
      { user_id: 'u-a', session_id: 's3', content_full: 'Draft the month-end   variance commentary.', occurred_at: NOW - 1 * DAY }, // duplicate of the s1 opener
      { user_id: 'u-c', session_id: 's4', content_full: 'variance commentary for june', occurred_at: String(NOW - 20 * DAY) }, // PG string bigint
    ];
    const c = buildCorpusFromRows(rows, 2);
    expect(c.excerpts.map(e => e.sessionId)).toEqual(['s4', 's1', 's1', 's2', 's3']);
    expect(c.excerpts[0].occurredAt).toBe(NOW - 20 * DAY);           // Number() coercion
    expect(c.excerpts.map(e => e.personLabel)).toEqual(['A', 'B', 'B', 'C', 'B']); // first-appearance order
    expect(c.excerpts.map(e => e.isFollowUp)).toEqual([false, false, true, false, false]);
    expect(c.excerpts[2].text).not.toContain('james.l@example.com');  // redactPii in
    expect(c.excerpts.every((e, i) => e.index === i)).toBe(true);
    expect(c.stats).toEqual({
      prompts: 5, distinctPrompts: 4, people: 3, sessions: 4, days: 4, followUps: 1,
      weeksSpanned: 3, unreadableSessions: 2, firstAt: NOW - 20 * DAY, lastAt: NOW - 1 * DAY, promptsShown: 5,
    });
  });

  it('caps per user and in total, truncating a session that does not fit to its opener and earliest follow-ups', async () => {
    const { buildCorpusFromRows, MAX_EXCERPTS_PER_USER } = await import('@/lib/usecases/skill-corpus');
    const rows = [];
    for (let s = 0; s < 8; s++) for (let m = 0; m < 3; m++) {
      rows.push({ user_id: 'u-a', session_id: `s${s}`, content_full: `prompt ${s} ${m}`, occurred_at: NOW - s * DAY + m });
    }
    const c = buildCorpusFromRows(rows, 0);
    // Newest first: s0, s1, s2 whole (9), then s3 truncated to its opener (10).
    expect(c.excerpts.length).toBe(MAX_EXCERPTS_PER_USER);
    expect(c.excerpts.filter(e => e.sessionId === 's3').map(e => e.text)).toEqual(['prompt 3 0']);
    for (const sid of ['s0', 's1', 's2']) expect(c.excerpts.filter(e => e.sessionId === sid)).toHaveLength(3);
    expect(c.excerpts.some(e => ['s4', 's5', 's6', 's7'].includes(e.sessionId))).toBe(false);
    // Stats count the FULL readable evidence, not the sample (branch review #1).
    expect(c.stats.prompts).toBe(24);
    expect(c.stats.sessions).toBe(8);
    expect(c.stats.promptsShown).toBe(c.excerpts.length);
  });

  it('readiness stats count every readable prompt, so a busy solo owner is measured on all of their work, not the capped sample', async () => {
    const { buildCorpusFromRows, MAX_EXCERPTS_PER_USER } = await import('@/lib/usecases/skill-corpus');
    const rows = [];
    for (let s = 0; s < 12; s++) for (let m = 0; m < 3; m++) {
      rows.push({ user_id: 'u-solo', session_id: `s${s}`, content_full: `session ${s} prompt ${m} about the variance pack`, occurred_at: NOW - s * 4 * DAY + m * 60 });
    }
    const c = buildCorpusFromRows(rows, 0);
    expect(c.stats.people).toBe(1);
    expect(c.stats.prompts).toBe(36);
    expect(c.stats.distinctPrompts).toBe(36);
    expect(c.stats.sessions).toBe(12);
    expect(c.stats.days).toBe(12);
    expect(c.stats.followUps).toBe(24);
    expect(c.stats.weeksSpanned).toBeGreaterThanOrEqual(7);
    expect(c.stats.firstAt).toBe(NOW - 11 * 4 * DAY);
    expect(c.stats.lastAt).toBe(NOW + 2 * 60);
    expect(c.excerpts.length).toBeLessThanOrEqual(MAX_EXCERPTS_PER_USER);
    expect(c.stats.promptsShown).toBe(c.excerpts.length);

    const { assessReadiness, DEFAULT_THRESHOLDS } = await import('@/lib/usecases/skill-readiness');
    expect(assessReadiness(c.stats, DEFAULT_THRESHOLDS)).toMatchObject({ ready: true, mode: 'solo' });
  });

  it('a person who works in long sessions still reaches the model: an oversized session keeps its opener, never a follow-up without it', async () => {
    const { buildCorpusFromRows, MAX_EXCERPTS_PER_USER } = await import('@/lib/usecases/skill-corpus');
    const rows = [];
    for (let s = 0; s < 6; s++) for (let m = 0; m < 12; m++) {
      rows.push({ user_id: 'u-long', session_id: `s${s}`, content_full: `session ${s} prompt ${m} on the variance pack`, occurred_at: NOW - s * 7 * DAY + m * 60 });
    }
    const c = buildCorpusFromRows(rows, 0);
    expect(c.stats.prompts).toBe(72);
    expect(c.excerpts.length).toBeGreaterThanOrEqual(1);
    expect(c.excerpts.length).toBeLessThanOrEqual(MAX_EXCERPTS_PER_USER);
    expect(c.stats.promptsShown).toBe(c.excerpts.length);
    // Every kept session starts with its opener, and its follow-ups are its earliest ones, in order.
    for (const sid of new Set(c.excerpts.map(e => e.sessionId))) {
      const kept = c.excerpts.filter(e => e.sessionId === sid);
      const all = rows.filter(r => r.session_id === sid).sort((a, b) => a.occurred_at - b.occurred_at);
      expect(kept[0].isFollowUp).toBe(false);
      expect(kept[0].text).toBe(all[0].content_full);
      expect(kept.map(e => e.text)).toEqual(all.slice(0, kept.length).map(r => r.content_full));
    }
  });

  it('the total cap truncates the same way, and a session is skipped only when not even its opener fits', async () => {
    const { buildCorpusFromRows, MAX_EXCERPTS_PER_DRAFT } = await import('@/lib/usecases/skill-corpus');
    const rows = [];
    // 8 people x one 9-prompt session = 72 prompts; the total cap (60) bites before any per-user cap.
    for (let u = 0; u < 8; u++) for (let m = 0; m < 9; m++) {
      rows.push({ user_id: `u${u}`, session_id: `s${u}`, content_full: `person ${u} prompt ${m}`, occurred_at: NOW - u * DAY + m * 60 });
    }
    const c = buildCorpusFromRows(rows, 0);
    expect(c.excerpts.length).toBe(MAX_EXCERPTS_PER_DRAFT);
    // Newest first: s0..s5 whole (54), s6 truncated to 6, s7 has no room left for its opener.
    expect(c.excerpts.filter(e => e.sessionId === 's6').map(e => e.text)).toEqual([0, 1, 2, 3, 4, 5].map(m => `person 6 prompt ${m}`));
    expect(c.excerpts.some(e => e.sessionId === 's7')).toBe(false);
    expect(c.stats.people).toBe(8);
  });
});

describe('gatherSkillCorpus (database)', () => {
  let sql: TestSql; let cleanup: () => Promise<void>;
  beforeAll(async () => { const t = await createTestDatabase(); sql = t.sql; cleanup = t.cleanup; });
  afterAll(async () => cleanup());

  it('reads only cowork user messages from the matched sessions inside the window, counts unreadable sessions, lists systems', async () => {
    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Corpus UC', status: 'confirmed' });
    const { weekStart } = await import('@/lib/pulse/period');
    const nowS = Math.floor(Date.now() / 1000);
    const recent = nowS - 3 * DAY, old = nowS - 120 * DAY;

    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)`, ['u1', 'u1@x.test', 'U1', 'otel', old, nowS]);
    const msg = (...p: unknown[]) => sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, content_preview, content_full, source) VALUES (?,?,?,?,?,?,?,?,?)`, p);
    await msg('m1', 's-in', 'u1', 'cowork_user_message', 'cowork', recent, 'p', 'variance commentary for the pack', 'otel');
    await msg('m2', 's-in', 'u1', 'cowork_tool_metadata', 'cowork', recent + 1, 'Write', null, 'otel');   // not a user message
    await msg('m3', 's-stripped', 'u1', 'cowork_user_message', 'cowork', recent, 'p', null, 'otel');        // retention-stripped
    await msg('m4', 's-old', 'u1', 'cowork_user_message', 'cowork', old, 'p', 'ancient prompt', 'otel');    // outside window
    await msg('m5', 's-code', 'u1', 'code_user_message', 'code', recent, 'p', 'code prompt', 'otel');       // wrong surface
    const wm = (...p: unknown[]) => sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?,?,?,?)`, p);
    await wm(uc.id, weekStart(recent), 'u1', 's-in');
    await wm(uc.id, weekStart(recent), 'u1', 's-stripped');
    await wm(uc.id, weekStart(old), 'u1', 's-old');
    await wm(uc.id, weekStart(recent), 'u1', 's-code');
    await wm(uc.id, weekStart(recent), 'u1', '');                                                          // occurrences-only row
    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, source) VALUES (?,?,?,?,?,?)`, ['si1', 'u1', 's-in', 'anthropic-skills:xlsx', recent, 'otel']);

    const { gatherSkillCorpus } = await import('@/lib/usecases/skill-corpus');
    const c = await gatherSkillCorpus(uc.id, nowS);
    expect(c.excerpts.map(e => e.text)).toEqual(['variance commentary for the pack']);
    expect(c.stats.unreadableSessions).toBe(1);   // s-stripped only; s-code has no cowork rows at all
    expect(c.systems).toEqual(['anthropic-skills:xlsx']);
  });
});

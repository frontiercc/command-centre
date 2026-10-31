// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's Chat, Work and Code figures and its vendor switch: Claude
// Chat and ChatGPT Chat count as Chat, Claude Cowork and ChatGPT Work as Work,
// Claude Code and Codex as Code; each narrows to Claude or OpenAI. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;

  await sql.run(`INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at) VALUES
    ('u-claude', 'ana@example.org', 'Ana', 'Finance', 'otel', 1, ?),
    ('u-openai', 'ben@example.org', 'Ben', 'Finance', 'openai', 1, ?),
    ('u-both', 'cy@example.org', 'Cy', 'Sales', 'otel', 1, ?)`, [NOW, NOW, NOW]);

  // [id, session, user, surface, source, flagged, hours ago]
  const rows: Array<[string, string, string, string, string, number, number]> = [
    ['m1', 'cc-1', 'u-claude', 'chat', 'compliance', 0, 2],         // Claude Chat
    ['m2', 'chatgpt:c1', 'u-openai', 'cowork', 'chatgpt_chat', 1, 3], // ChatGPT Chat
    ['m3', 'chatgpt:c2', 'u-openai', 'cowork', 'chatgpt_chat', 0, 4], // ChatGPT Chat
    ['m4', 'cw-1', 'u-claude', 'cowork', 'otel', 1, 5],              // Claude Cowork
    ['m5', 'chatgpt:w1', 'u-both', 'cowork', 'chatgpt_work', 0, 6],  // ChatGPT Work
    ['m6', 'code-1', 'u-both', 'code', 'otel', 0, 7],                // Claude Code
    ['m7', 'codex:s1', 'u-openai', 'code', 'codex', 1, 8],           // Codex
    ['m8', 'codex:s1', 'u-openai', 'code', 'codex', 0, 9],           // Codex
  ];
  for (const [id, session, user, surface, source, flagged, ago] of rows) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, flagged, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, session, user, surface === 'code' ? 'code_user_message' : 'cowork_user_message', surface, source, flagged, NOW - ago * HOUR]);
  }
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at) VALUES
    ('code-1', 'u-both', ?, ?, ?), ('codex:s1', 'u-openai', ?, ?, ?)`,
    [NOW - 7 * HOUR, NOW - 7 * HOUR, NOW, NOW - 9 * HOUR, NOW - 8 * HOUR, NOW]);
});
afterAll(async () => cleanup());

describe('dashboard figures by kind of work and vendor', () => {
  it('splits sessions a week into Chat, Work and Code, Claude and OpenAI, adding up', async () => {
    const { getSessionsPerWeekByProduct } = await import('@/lib/dashboard/queries');
    const s = await getSessionsPerWeekByProduct(NOW);
    expect(s.chat).toEqual({ total: 3, claude: 1, openai: 2 });
    expect(s.work).toEqual({ total: 2, claude: 1, openai: 1 });
    expect(s.code).toEqual({ total: 2, claude: 1, openai: 1 });
  });

  it('counts flagged prompts by kind and vendor', async () => {
    const { getFlaggedByProduct } = await import('@/lib/dashboard/queries');
    const f = await getFlaggedByProduct();
    expect(f.chat).toEqual({ total: 1, claude: 0, openai: 1 });
    expect(f.work).toEqual({ total: 1, claude: 1, openai: 0 });
    expect(f.code).toEqual({ total: 1, claude: 0, openai: 1 });
  });

  it('counts the week’s people by vendor', async () => {
    const { getActiveUsersByVendor, getActiveUsersForVendor } = await import('@/lib/dashboard/queries');
    expect(await getActiveUsersByVendor(NOW + 1)).toEqual({ claude: 2, openai: 2 });
    expect(await getActiveUsersForVendor('openai', NOW + 1)).toBe(2);
    expect(await getActiveUsersForVendor('claude', NOW + 1)).toBe(2);
  });

  it('narrows the trend to each vendor, and All adds them', async () => {
    const { getAdoptionTrendByVendor } = await import('@/lib/dashboard/queries');
    const sum = (rows: Array<{ surface_chat: number; surface_code: number; surface_cowork: number }>) =>
      rows.reduce((a, r) => ({ chat: a.chat + r.surface_chat, code: a.code + r.surface_code, work: a.work + r.surface_cowork }), { chat: 0, code: 0, work: 0 });
    const claude = sum(await getAdoptionTrendByVendor(14, 'claude'));
    const openai = sum(await getAdoptionTrendByVendor(14, 'openai'));
    const all = sum(await getAdoptionTrendByVendor(14, 'all'));
    // Chat and Code count prompts; Work counts people a day.
    expect(openai.chat).toBe(2);
    expect(openai.code).toBe(2);
    expect(claude.chat).toBe(1);
    expect(claude.code).toBe(1);
    expect(all.chat).toBe(claude.chat + openai.chat);
    expect(all.code).toBe(claude.code + openai.code);
    expect(all.work).toBe(claude.work + openai.work);
  });

  it('ranks top people per vendor and adds both for All', async () => {
    const { getTopUsersByVendor } = await import('@/lib/dashboard/queries');
    const openai = await getTopUsersByVendor(5, 'openai');
    expect(openai.map(u => [u.id, u.surface_chat, u.surface_cowork, u.surface_code])).toEqual([
      ['u-openai', 2, 0, 2],
      ['u-both', 0, 1, 0],
    ]);
    const all = await getTopUsersByVendor(5, 'all');
    expect(all.find(u => u.id === 'u-both')).toMatchObject({ surface_cowork: 1, surface_code: 1, total_activity: 2 });
  });

  it('counts people per department per kind for a vendor', async () => {
    const { getDepartmentBreakdownByVendor } = await import('@/lib/dashboard/queries');
    const finance = (await getDepartmentBreakdownByVendor('openai')).find(d => d.department === 'Finance')!;
    expect(finance).toMatchObject({ surface_chat: 1, surface_cowork: 0, surface_code: 1 });
    const claudeFinance = (await getDepartmentBreakdownByVendor('claude')).find(d => d.department === 'Finance')!;
    expect(claudeFinance).toMatchObject({ surface_chat: 1, surface_cowork: 1, surface_code: 0 });
  });

  it('measures stickiness for the chosen vendor, with ChatGPT Chat under Chat', async () => {
    const { getProductStickiness } = await import('@/lib/pulse/stickiness');
    const openai = await getProductStickiness(NOW, 'openai');
    expect(openai.chat.mau).toBe(1);
    expect(openai.cowork.mau).toBe(1); // ChatGPT Work
    expect(openai.code.mau).toBe(1);
    const all = await getProductStickiness(NOW);
    expect(all.chat.mau).toBe(2);
  });

  it('counts this week’s sessions for each product, for the briefing', async () => {
    const { getSessionsThisWeekByProduct } = await import('@/lib/dashboard/queries');
    expect(await getSessionsThisWeekByProduct(NOW + 1)).toEqual({
      chat: { claudeChat: 1, chatgptChat: 2 },
      work: { claudeCowork: 1, chatgptWork: 1 },
      code: { claudeCode: 1, codex: 1 },
    });
  });

  it('splits the week’s tier mix by vendor', async () => {
    const { getTierMixThisWeekByVendor } = await import('@/lib/dashboard/queries');
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at) VALUES
      ('m1', 'u-claude', 2, 'analysis', 0.9, 'test', ?), ('m4', 'u-claude', 3, 'analysis', 0.9, 'test', ?),
      ('m2', 'u-openai', 1, 'drafting', 0.9, 'test', ?), ('m5', 'u-both', 2, 'analysis', 0.9, 'test', ?)`, [NOW, NOW, NOW, NOW]);
    expect(await getTierMixThisWeekByVendor(NOW + 1)).toEqual({
      claude: { tier1: 0, tier2: 1, tier3: 1 },
      openai: { tier1: 1, tier2: 1, tier3: 0 },
    });
  });

  it('knows when OpenAI data exists', async () => {
    const { hasOpenAiData } = await import('@/lib/dashboard/queries');
    expect(await hasOpenAiData()).toBe(true);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The OpenAI sync end to end on Postgres: the real sync, over real HTTP,
// against the localhost stand-in for OpenAI's export (scripts/openai-mock),
// into a migrated test database. Proves the paging, the signed-link download,
// at-least-once delivery (repeats stored once), the Work-in-both-logs skip, the
// retention floor, people created by email, flags on risky prompts, the
// cursor, spend (hourly costs, ChatGPT reply times, Codex turns) kept apart
// from Claude's, that a costs-only key reads costs and nothing else, and
// that people on the exclusion list are dropped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PORT = 41000 + Math.floor(Math.random() * 2000);
const WORKSPACE_ID = '7f3c2a10-5b1e-4c8d-9a6f-0e2d4b8c1a55';
const ORGANIZATION_ID = 'org-MockAcmeCorp000000000000';

let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'scripts/openai-mock/server.mjs')], {
    env: { ...process.env, OPENAI_MOCK_PORT: String(PORT), OPENAI_MOCK_DAYS: '5', OPENAI_MOCK_RATE_LIMIT: '1000000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 30_000);
    server.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('Mock OpenAI')) { clearTimeout(timer); resolve(); }
    });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock server exited ${code}`)); });
  });
  process.env.CCC_OPENAI_API_BASE_URL = `http://localhost:${PORT}/v1`;
}, 40_000);

afterAll(() => {
  server?.kill();
  delete process.env.CCC_OPENAI_API_BASE_URL;
});

describe('OpenAI sync against the stand-in export', () => {
  it('stores ChatGPT and Codex prompts where Claude prompts live, once each', async () => {
    const { createTestDatabase } = await import('./helpers/db');
    const { sql, cleanup } = await createTestDatabase();
    try {
      const { setConfigValue, getConfigValue } = await import('@/lib/config');
      const { runOpenAiSync } = await import('@/lib/openai/sync');

      await setConfigValue('openaiAdminApiKey', 'mock-admin-key');
      await setConfigValue('openaiWorkspaceId', WORKSPACE_ID);
      await setConfigValue('openaiOrganizationId', ORGANIZATION_ID);
      // Cowork kept for a short window only: older ChatGPT prompts must not
      // come back. The stand-in is mostly quiet at weekends, so the window
      // always reaches back over a full weekday: 2 days, 3 on a Sunday, 4 on a Monday.
      const weekday = new Date().getUTCDay();
      const windowDays = weekday === 0 ? 3 : weekday === 1 ? 4 : 2;
      await setConfigValue('retentionCoworkDays', String(windowDays));

      const syncStartS = Math.floor(Date.now() / 1000);
      const first = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(first.errors).toEqual([]);
      expect(first.files).toBeGreaterThan(0);
      expect(first.prompts.chatgpt_chat).toBeGreaterThan(0);
      expect(first.prompts.chatgpt_work).toBeGreaterThan(0);
      expect(first.prompts.codex).toBeGreaterThan(0);
      // The stand-in repeats ~2% of events in a second file; those are stored once.
      expect(first.repeats).toBeGreaterThan(0);
      // ChatGPT Work prompts also appear in the Codex log and are skipped there.
      expect(first.workInCodexLog).toBeGreaterThan(0);
      expect(first.tooOld).toBeGreaterThan(0);

      // Where each source lands.
      const bySource = await sql.all<{ source: string; surface: string; message_type: string; n: number }>(
        `SELECT source, surface, message_type, COUNT(*) AS n FROM cowork_messages GROUP BY source, surface, message_type ORDER BY source`,
      );
      expect(bySource).toEqual([
        { source: 'chatgpt_chat', surface: 'cowork', message_type: 'cowork_user_message', n: first.prompts.chatgpt_chat },
        { source: 'chatgpt_work', surface: 'cowork', message_type: 'cowork_user_message', n: first.prompts.chatgpt_work },
        { source: 'codex', surface: 'code', message_type: 'code_user_message', n: first.prompts.codex },
      ]);

      // Skills ChatGPT replies used, and connector calls from the Codex log,
      // join the skill and connector tables under their OpenAI source.
      expect(first.skillUses).toBeGreaterThan(0);
      expect(first.connectorCalls).toBeGreaterThan(0);
      const skills = await sql.all<{ source: string; surface: string; n: number }>(
        `SELECT source, surface, COUNT(*) AS n FROM cowork_skill_invocations GROUP BY source, surface ORDER BY source`,
      );
      expect(skills.every(r => r.surface === 'cowork' && r.source.startsWith('chatgpt'))).toBe(true);
      expect(skills.reduce((n, r) => n + r.n, 0)).toBe(first.skillUses);
      const connectors = await sql.all<{ source: string; surface: string; mcp_server: string; n: number }>(
        `SELECT source, surface, mcp_server, COUNT(*) AS n FROM cowork_mcp_invocations GROUP BY source, surface, mcp_server`,
      );
      expect(connectors).toEqual([{ source: 'codex', surface: 'code', mcp_server: 'linear', n: first.connectorCalls }]);
      // The Get started panel's optional step ticks on the first OpenAI prompt.
      expect(Number(await getConfigValue('setupFirstOpenaiAt'))).toBeGreaterThanOrEqual(syncStartS);

      // Spend, kept apart from Claude's: hourly costs, ChatGPT reply times
      // and Codex turns, never in cowork_messages or code_assistant_meta.
      expect(first.costRecords).toBeGreaterThan(0);
      expect(first.replies).toBeGreaterThan(0);
      expect(first.codexTurns).toBeGreaterThan(0);
      const claudeSpendRows = await sql.all<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM cowork_messages WHERE message_type = 'cowork_api_request')
              + (SELECT COUNT(*) FROM code_assistant_meta) AS n`,
      );
      expect(claudeSpendRows[0].n).toBe(0);
      const costs = await sql.all<{ product: string; billed_in: string; n: number; usd: number; oldest: number }>(
        `SELECT product, billed_in, COUNT(*) AS n, SUM(cost_usd) AS usd, MIN(hour_start) AS oldest
           FROM openai_costs GROUP BY product, billed_in ORDER BY product, billed_in`,
      );
      expect(costs.map(c => c.product)).toEqual(expect.arrayContaining(['chatgpt', 'codex']));
      // One person is billed in dollars, everyone else in credits valued at OpenAI's estimate.
      expect(costs.some(c => c.product === 'chatgpt' && c.billed_in === 'USD')).toBe(true);
      expect(costs.some(c => c.product === 'chatgpt' && c.billed_in === 'CREDITS')).toBe(true);
      expect(costs.every(c => c.usd > 0)).toBe(true);
      // ChatGPT costs honour the Cowork window, like its prompts.
      for (const c of costs.filter(c => c.product === 'chatgpt')) expect(c.oldest + 3600).toBeGreaterThan(syncStartS - windowDays * 86400);
      const costPeople = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM openai_costs WHERE product = 'chatgpt' AND user_id IS NOT NULL`);
      expect(costPeople[0].n).toBeGreaterThan(0);
      const replies = await sql.all<{ source: string; n: number }>(
        `SELECT source, COUNT(*) AS n FROM openai_replies GROUP BY source ORDER BY source`,
      );
      expect(replies.map(r => r.source)).toEqual(['chatgpt_chat', 'chatgpt_work']);
      // Codex turns only: ChatGPT Work's spend arrives in COSTS under ChatGPT.
      const turns = await sql.all<{ bad: number; models: string }>(
        `SELECT COUNT(*) FILTER (WHERE session_id NOT LIKE 'codex:%' OR openai_cost_usd IS NULL) AS bad,
                string_agg(DISTINCT model, ',' ORDER BY model) AS models FROM codex_turns`,
      );
      expect(turns[0].bad).toBe(0);

      // The readers: ChatGPT and Codex are both tokens × the rates table, and a
      // model with no rate is named, never $0. The stand-in uses the rate
      // cards' model names and credits at $0.04, so the built-in USD rates give
      // back OpenAI's figure for the same records.
      const { chatgptSpend, codexSpend } = await import('@/lib/openai/spend');
      const chatgptTotal = costs.filter(c => c.product === 'chatgpt').reduce((n, c) => n + c.usd, 0);
      const builtIn = await chatgptSpend({ since: 0 });
      expect(builtIn?.unpricedModels).toEqual([]);
      expect(builtIn?.openaiUsd).toBeCloseTo(chatgptTotal, 4);
      expect(Math.abs(builtIn!.usd - chatgptTotal) / chatgptTotal).toBeLessThan(0.01);
      expect((await chatgptSpend({ since: 0 }, {}))?.usd).toBe(0);
      expect((await chatgptSpend({ since: 0, userIds: [] }))?.usd).toBe(0);
      const unpriced = await codexSpend({ since: 0 }, {});
      expect(unpriced.usd).toBeNull();
      expect(unpriced.unpricedModels).toEqual(turns[0].models.split(',').sort());
      expect(unpriced.turns).toBe(first.codexTurns);
      // The built-in USD rates give back OpenAI's estimate for the same turns.
      const priced = await codexSpend({ since: 0 });
      expect(priced.unpricedModels).toEqual([]);
      expect(priced.usd).not.toBeNull();
      expect(Math.abs(priced.usd! - priced.openaiUsd) / priced.openaiUsd).toBeLessThan(0.01);

      // No Work prompt was stored twice under Codex.
      const workTwice = await sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cowork_messages w JOIN cowork_messages c
           ON c.source = 'codex' AND c.content_full = w.content_full AND c.user_id = w.user_id
          WHERE w.source = 'chatgpt_work'`,
      );
      expect(workTwice[0].n).toBe(0);

      // Retention floor: no ChatGPT prompt older than the Cowork window,
      // while Codex (Claude Code window, 90 days) keeps the full 5 days.
      const nowS = syncStartS;
      const oldest = await sql.all<{ source: string; oldest: number }>(
        `SELECT source, MIN(occurred_at) AS oldest FROM cowork_messages GROUP BY source`,
      );
      for (const r of oldest) {
        if (r.source.startsWith('chatgpt')) expect(r.oldest).toBeGreaterThanOrEqual(nowS - windowDays * 86400);
      }
      expect(oldest.find(r => r.source === 'codex')!.oldest).toBeLessThan(nowS - 3 * 86400);

      // People are created by email, labelled as first seen through OpenAI.
      const people = await sql.all<{ email: string; source: string }>(`SELECT email, source FROM users`);
      expect(people.length).toBeGreaterThan(5);
      expect(people.every(p => p.source === 'openai')).toBe(true);
      const accounts = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_users WHERE password_hash = '__otel_pending__'`);
      expect(accounts[0].n).toBe(people.length);

      // One Cowork session per ChatGPT conversation, with attached file names.
      const sessions = await sql.all<{ source: string; n: number; with_files: number }>(
        `SELECT source, COUNT(*) AS n, COUNT(files_uploaded) AS with_files FROM cowork_sessions GROUP BY source ORDER BY source`,
      );
      expect(sessions.map(s => s.source)).toEqual(['chatgpt_chat', 'chatgpt_work']);
      expect(sessions.reduce((n, s) => n + s.with_files, 0)).toBeGreaterThan(0);
      const orphanPrompts = await sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cowork_messages m LEFT JOIN cowork_sessions s ON s.id = m.session_id
          WHERE m.source LIKE 'chatgpt%' AND s.id IS NULL`,
      );
      expect(orphanPrompts[0].n).toBe(0);

      // Risky prompts are flagged on insert, like Claude prompts.
      const sensitive = await sql.all<{ flagged: number; flag_reason: string | null; content_full: string }>(
        `SELECT flagged, flag_reason, content_full FROM cowork_messages
          WHERE content_full LIKE '%QQ 12 34 56 C%' OR content_full LIKE '%personal Gmail%' OR content_full LIKE '%harbourline.example%'`,
      );
      for (const s of sensitive) expect(s.flagged).toBe(1);

      // Codex prompts get the same checks: a quoted password and an access key
      // (personal data and secrets), an export to a personal Dropbox and
      // switching off logging (intent). Which risky prompts the stand-in sends
      // depends on the date, so every flagged Codex prompt must raise an alert.
      const codexRisky = await sql.all<{ id: string; flag_reason: string | null; content_full: string }>(
        `SELECT id, flag_reason, content_full FROM cowork_messages WHERE source = 'codex' AND flagged = 1`,
      );
      expect(codexRisky.length).toBeGreaterThanOrEqual(3);
      const reasonFor = (marker: string) => codexRisky.find(r => r.content_full.includes(marker))?.flag_reason ?? '';
      if (codexRisky.some(r => r.content_full.includes('Wint3r'))) expect(reasonFor('Wint3r')).toContain('generic_secret');
      if (codexRisky.some(r => r.content_full.includes('AKIA'))) expect(reasonFor('AKIA')).toContain('aws_key');
      if (codexRisky.some(r => r.content_full.includes('personal Dropbox'))) expect(reasonFor('personal Dropbox')).toContain('shadow_it');
      if (codexRisky.some(r => r.content_full.includes('Disable logging'))) expect(reasonFor('Disable logging')).toContain('Intent detected');
      // Every flagged ChatGPT and Codex prompt raises an alert. How many risky
      // ChatGPT prompts fall inside the window depends on the date, and
      // on some dates there are none, so this checks every source present.
      const flaggedBySource = await sql.all<{ source: string; n: number }>(
        `SELECT source, COUNT(*) AS n FROM cowork_messages WHERE flagged = 1 GROUP BY source`,
      );
      const { vi } = await import('vitest');
      await vi.waitFor(async () => {
        const alerted = await sql.all<{ source: string; n: number }>(
          `SELECT m.source, COUNT(DISTINCT m.id) AS n FROM alerts a JOIN cowork_messages m ON a.raw_evidence::text LIKE '%' || m.id || '%'
            GROUP BY m.source`,
        );
        for (const f of flaggedBySource) expect(alerted.find(a => a.source === f.source)?.n ?? 0).toBe(f.n);
      }, { timeout: 15_000, interval: 250 });
      // Personal-data alert text names where the prompt came from, never OTel.
      const piiText = await sql.all<{ explanation: string }>(`SELECT explanation FROM alerts WHERE alert_type = 'policy'`);
      expect(piiText.length).toBeGreaterThan(0);
      for (const a of piiText) {
        expect(a.explanation).not.toContain('via OTel');
        expect(a.explanation).toMatch(/via (ChatGPT Chat|ChatGPT Work|Codex) \(OpenAI export\)/);
      }
      const chatPii = await sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cowork_messages WHERE source = 'chatgpt_chat' AND flag_reason LIKE 'PII detected:%'`,
      );
      if (chatPii[0].n > 0) expect(piiText.some(a => a.explanation.includes('via ChatGPT Chat (OpenAI export)'))).toBe(true);

      // Cursor saved per log type.
      const cursors = JSON.parse(await getConfigValue('openaiSyncCursors'));
      expect(Object.keys(cursors).sort()).toEqual(['CODEX_LOG', 'CODEX_TURN', 'CONVERSATION_MESSAGE', 'COSTS']);

      // A second run from the saved cursor finds nothing new.
      const second = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(second.errors).toEqual([]);
      expect(second.prompts).toEqual({ chatgpt_chat: 0, chatgpt_work: 0, codex: 0 });

      // Replaying every file from the start stores nothing twice.
      await setConfigValue('openaiSyncCursors', '');
      const replay = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(replay.errors).toEqual([]);
      expect(replay.prompts).toEqual({ chatgpt_chat: 0, chatgpt_work: 0, codex: 0 });
      expect(replay.skillUses).toBe(0);
      expect(replay.connectorCalls).toBe(0);
      expect([replay.replies, replay.codexTurns, replay.costRecords]).toEqual([0, 0, 0]);
      const total = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages`);
      expect(total[0].n).toBe(first.prompts.chatgpt_chat + first.prompts.chatgpt_work + first.prompts.codex);

      // A per-run cap stops early and the next run carries on from the cursor.
      await sql.run(`DELETE FROM cowork_messages`);
      await setConfigValue('openaiSyncCursors', '');
      const capped = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 5 });
      expect(capped.files).toBe(5);
      // The cap is shared, so every log moves forward in the same run.
      expect(Object.keys(JSON.parse(await getConfigValue('openaiSyncCursors'))).sort()).toEqual(['CODEX_LOG', 'CODEX_TURN', 'CONVERSATION_MESSAGE', 'COSTS']);
      const rest = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(rest.files).toBe(first.files - 5);

      // A costs-only key reads costs and none of the workspace logs: no
      // prompt is stored and only the COSTS cursor moves.
      await sql.run(`DELETE FROM cowork_messages`);
      await sql.run(`DELETE FROM openai_costs`);
      await setConfigValue('openaiSyncCursors', '');
      await setConfigValue('openaiAdminApiKey', 'mock-costs-key');
      const refused = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(refused.errors).toHaveLength(3);
      expect(refused.errors.every(e => e.includes('403'))).toBe(true);
      expect(refused.costRecords).toBeGreaterThan(0);
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages`))[0].n).toBe(0);
      expect(Object.keys(JSON.parse(await getConfigValue('openaiSyncCursors')))).toEqual(['COSTS']);

      // Let the fire-and-forget alert writes settle before the database goes.
      await new Promise(r => setTimeout(r, 500));
    } finally {
      await cleanup();
    }
  }, 300_000);

  it('drops everything for people on the exclusion list', async () => {
    const { createTestDatabase } = await import('./helpers/db');
    const { sql, cleanup } = await createTestDatabase();
    try {
      const { setConfigValue } = await import('@/lib/config');
      const { runOpenAiSync } = await import('@/lib/openai/sync');
      await setConfigValue('openaiAdminApiKey', 'mock-admin-key');
      await setConfigValue('openaiWorkspaceId', WORKSPACE_ID);
      await setConfigValue('openaiOrganizationId', ORGANIZATION_ID);
      // Same key and format as Claude's telemetry; matched ignoring case.
      await setConfigValue('otelExcludedEmails', JSON.stringify(['Nadia.Okafor@acmecorp.example']));

      const stats = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(stats.errors).toEqual([]);
      expect(stats.excluded).toBeGreaterThan(0);
      expect(stats.prompts.chatgpt_chat).toBeGreaterThan(0);

      const person = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'nadia.okafor@acmecorp.example'`);
      expect(person[0].n).toBe(0);
      for (const table of ['cowork_messages', 'openai_costs', 'openai_replies', 'cowork_skill_invocations', 'cowork_mcp_invocations']) {
        const rows = await sql.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} t JOIN users u ON u.id = t.user_id WHERE lower(u.email) = 'nadia.okafor@acmecorp.example'`);
        expect(rows[0].n, table).toBe(0);
      }
      // Everyone else is still stored.
      const others = await sql.all<{ n: number }>(`SELECT COUNT(DISTINCT user_id) AS n FROM cowork_messages`);
      expect(others[0].n).toBeGreaterThan(1);

      // Last seen is each person's latest prompt, not the moment they were created.
      const stale = await sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users u
           JOIN (SELECT user_id, MAX(occurred_at) AS latest FROM cowork_messages GROUP BY user_id) m ON m.user_id = u.id
          WHERE u.last_seen_at IS DISTINCT FROM GREATEST(u.first_seen_at, m.latest)`);
      expect(stale[0].n).toBe(0);

      await new Promise(r => setTimeout(r, 500));
    } finally {
      await cleanup();
    }
  }, 300_000);
});

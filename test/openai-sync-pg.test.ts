// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The OpenAI sync end to end on Postgres: the real sync, over real HTTP,
// against the localhost stand-in for OpenAI's export (scripts/openai-mock),
// into a migrated test database. Proves the paging, the signed-link download,
// at-least-once delivery (repeats stored once), the Work-in-both-logs skip, the
// retention floor, people created by email, flags on risky prompts, the
// cursor, and that a costs-only key reads nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PORT = 41000 + Math.floor(Math.random() * 2000);
const WORKSPACE_ID = '7f3c2a10-5b1e-4c8d-9a6f-0e2d4b8c1a55';

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
      // Cowork kept for 2 days only: older ChatGPT prompts must not come back.
      await setConfigValue('retentionCoworkDays', '2');

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

      // No Work prompt was stored twice under Codex.
      const workTwice = await sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cowork_messages w JOIN cowork_messages c
           ON c.source = 'codex' AND c.content_full = w.content_full AND c.user_id = w.user_id
          WHERE w.source = 'chatgpt_work'`,
      );
      expect(workTwice[0].n).toBe(0);

      // Retention floor: no ChatGPT prompt older than the 2-day Cowork window,
      // while Codex (Claude Code window, 90 days) keeps the full 5 days.
      const nowS = syncStartS;
      const oldest = await sql.all<{ source: string; oldest: number }>(
        `SELECT source, MIN(occurred_at) AS oldest FROM cowork_messages GROUP BY source`,
      );
      for (const r of oldest) {
        if (r.source.startsWith('chatgpt')) expect(r.oldest).toBeGreaterThanOrEqual(nowS - 2 * 86400);
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
      // switching off logging (intent). Each is flagged and raises an alert.
      const codexRisky = await sql.all<{ id: string; flag_reason: string | null; content_full: string }>(
        `SELECT id, flag_reason, content_full FROM cowork_messages
          WHERE source = 'codex' AND (content_full LIKE '%Wint3r%' OR content_full LIKE '%AKIA%'
             OR content_full LIKE '%personal Dropbox%' OR content_full LIKE '%Disable logging%')`,
      );
      expect(codexRisky.length).toBeGreaterThanOrEqual(3);
      const reasonFor = (marker: string) => codexRisky.find(r => r.content_full.includes(marker))?.flag_reason ?? '';
      if (codexRisky.some(r => r.content_full.includes('Wint3r'))) expect(reasonFor('Wint3r')).toContain('generic_secret');
      if (codexRisky.some(r => r.content_full.includes('AKIA'))) expect(reasonFor('AKIA')).toContain('aws_key');
      if (codexRisky.some(r => r.content_full.includes('personal Dropbox'))) expect(reasonFor('personal Dropbox')).toContain('shadow_it');
      if (codexRisky.some(r => r.content_full.includes('Disable logging'))) expect(reasonFor('Disable logging')).toContain('Intent detected');
      const { vi } = await import('vitest');
      await vi.waitFor(async () => {
        const alerted = await sql.all<{ n: number }>(
          `SELECT COUNT(DISTINCT m.id) AS n FROM alerts a JOIN cowork_messages m ON a.raw_evidence::text LIKE '%' || m.id || '%'
            WHERE m.source = 'codex'`,
        );
        expect(alerted[0].n).toBe(codexRisky.length);
      }, { timeout: 15_000, interval: 250 });
      // Personal-data alert text names where the prompt came from, never OTel.
      const piiText = await sql.all<{ explanation: string }>(`SELECT explanation FROM alerts WHERE alert_type = 'policy'`);
      expect(piiText.length).toBeGreaterThan(0);
      for (const a of piiText) {
        expect(a.explanation).not.toContain('via OTel');
        expect(a.explanation).toMatch(/via (ChatGPT Chat|ChatGPT Work|Codex) \(OpenAI export\)/);
      }

      // Cursor saved per log type.
      const cursors = JSON.parse(await getConfigValue('openaiSyncCursors'));
      expect(Object.keys(cursors).sort()).toEqual(['CODEX_LOG', 'CONVERSATION_MESSAGE']);

      // A second run from the saved cursor finds nothing new.
      const second = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(second.errors).toEqual([]);
      expect(second.prompts).toEqual({ chatgpt_chat: 0, chatgpt_work: 0, codex: 0 });

      // Replaying every file from the start stores nothing twice.
      await setConfigValue('openaiSyncCursors', '');
      const replay = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(replay.errors).toEqual([]);
      expect(replay.prompts).toEqual({ chatgpt_chat: 0, chatgpt_work: 0, codex: 0 });
      const total = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages`);
      expect(total[0].n).toBe(first.prompts.chatgpt_chat + first.prompts.chatgpt_work + first.prompts.codex);

      // A per-run cap stops early and the next run carries on from the cursor.
      await sql.run(`DELETE FROM cowork_messages`);
      await setConfigValue('openaiSyncCursors', '');
      const capped = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 5 });
      expect(capped.files).toBe(5);
      // The cap is shared, so both logs move forward in the same run.
      expect(Object.keys(JSON.parse(await getConfigValue('openaiSyncCursors'))).sort()).toEqual(['CODEX_LOG', 'CONVERSATION_MESSAGE']);
      const rest = await runOpenAiSync({ downloadGapMs: 0, filesPerRun: 100_000 });
      expect(rest.files).toBe(first.files - 5);

      // A costs-only key can read neither log; nothing is stored and the
      // cursor does not move.
      await sql.run(`DELETE FROM cowork_messages`);
      await setConfigValue('openaiSyncCursors', '');
      await setConfigValue('openaiAdminApiKey', 'mock-costs-key');
      const refused = await runOpenAiSync({ downloadGapMs: 0 });
      expect(refused.errors).toHaveLength(2);
      expect(refused.errors.every(e => e.includes('403'))).toBe(true);
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_messages`))[0].n).toBe(0);
      expect(await getConfigValue('openaiSyncCursors')).toBe('');

      // Let the fire-and-forget alert writes settle before the database goes.
      await new Promise(r => setTimeout(r, 500));
    } finally {
      await cleanup();
    }
  }, 300_000);
});

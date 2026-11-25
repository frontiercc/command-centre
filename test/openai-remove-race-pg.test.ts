// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Remove (Admin → Access & Keys) landing in the gap between the OpenAI sync's key check and its
// saves. The gap is a few milliseconds, so it is forced here: Remove runs just before the save.
// Whenever it lands, nothing the sync saves outlives Remove, so a key added later starts again.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ID = '7f3c2a10-5b1e-4c8d-9a6f-0e2d4b8c1a55';
const STATE = ['openaiSyncCursors', 'openaiLastSyncAt', 'openaiLastSyncStats'] as const;

// The save Remove lands just before; cleared once it has.
let removeBefore: string | null = null;
vi.mock('@/lib/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/config')>('@/lib/config');
  return {
    ...actual,
    setConfigValue: async (key: Parameters<typeof actual.setConfigValue>[0], value: string) => {
      if (key === removeBefore) {
        removeBefore = null;
        // What Remove deletes: the key and the sync's own state.
        await actual.deleteConfigValues(['openaiAdminApiKey', ...STATE]);
      }
      return actual.setConfigValue(key, value);
    },
  };
});

let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'scripts/openai-mock/server.mjs')], {
    env: { ...process.env, OPENAI_MOCK_PORT: '0', OPENAI_MOCK_DAYS: '5', OPENAI_MOCK_RATE_LIMIT: '1000000', OPENAI_MOCK_FROZEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Port 0: the system picks a free port and the mock prints it. A random fixed
  // port could already be in use on the CI runner, and the mock then exited.
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 30_000);
    server.stdout!.on('data', (d: Buffer) => {
      const m = /Mock OpenAI .*localhost:(\d+)\/v1/.exec(d.toString());
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock server exited ${code}`)); });
  });
  process.env.CCC_OPENAI_API_BASE_URL = `http://localhost:${port}/v1`;
}, 40_000);

afterAll(() => {
  server?.kill();
  delete process.env.CCC_OPENAI_API_BASE_URL;
});

describe('OpenAI sync: Remove between the key check and a save', () => {
  const cases = [
    ['the sync position', 'openaiSyncCursors'],
    ['the last sync time and figures', 'openaiLastSyncAt'],
  ] as const;

  for (const [what, key] of cases) {
    it(`keeps nothing when Remove lands just before saving ${what}`, async () => {
      const { createTestDatabase } = await import('./helpers/db');
      const { sql, cleanup } = await createTestDatabase();
      try {
        const { setConfigValue } = await import('@/lib/config');
        const { runOpenAiSyncJob } = await import('@/lib/openai/job');
        await setConfigValue('openaiAdminApiKey', 'mock-admin-key');
        await setConfigValue('openaiWorkspaceId', WORKSPACE_ID);

        removeBefore = key;
        await runOpenAiSyncJob({ force: true, downloadGapMs: 0, filesPerRun: 3 });
        expect(removeBefore, 'Remove ran').toBeNull();

        const rows = await sql.all<{ key: string }>(
          `SELECT key FROM config WHERE key IN ('openai_admin_api_key', 'openai_sync_cursors', 'openai_last_sync_at', 'openai_last_sync_stats')`);
        expect(rows).toEqual([]);
      } finally {
        removeBefore = null;
        await cleanup();
      }
    }, 120_000);
  }
});

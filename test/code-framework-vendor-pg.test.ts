// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Dev Framework Alignment with Developer Pulse's All / Claude / Codex switch:
// once Codex data exists and is shown, each view reads its own
// code_metrics_vendor row, and in the Codex view the signals Codex never
// reports read "not captured", never 0. Hidden or no Codex: Claude Code's row.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TestSql } from './helpers/sql';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(async () => ({ authenticated: true, role: 'viewer' })),
  canAccessOrgOverview: (r: string) => ['admin', 'manager', 'viewer'].includes(r),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/pulse/code/framework/route');
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let ORG: string;
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  route = await import('../app/api/pulse/code/framework/route');
  ({ setConfigValue } = await import('@/lib/config'));
  ({ ORG_SCOPE_ID: ORG } = await import('@/lib/pulse/code/aggregator'));
  await setConfigValue('dxFrameworkEnabled', 'true');
});
afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics; DELETE FROM code_metrics_vendor; DELETE FROM cowork_messages;`);
  await setConfigValue('openaiShown', 'true');
  await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, granularity, period_start, period_end, commit_count, pr_count,
      lines_added, lines_removed, edit_accept_count, edit_reject_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
    VALUES ('organisation', ?, 'rolling', ?, ?, 4, 2, 100, 10, 8, 2, 3600, 0, 5, ?)`, [ORG, NOW - 7 * 86400, NOW, NOW]);
});

async function seedCodex() {
  await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, occurred_at, ingested_at)
    VALUES ('cx-1', NULL, 'codex:s', 'code_user_message', 'code', 'codex', ?, ?)`, [NOW, NOW]);
  const row = (vendor: string, commits: number, prs: number, lines: number, accept: number, secs: number, spend: number) => sql.run(
    `INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, granularity, period_start, period_end, commit_count, pr_count,
       lines_added, lines_removed, edit_accept_count, edit_reject_count, active_time_user_s, active_time_cli_s, spend_usd, computed_at)
     VALUES (?, 'organisation', ?, 'rolling', ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, ?, ?)`,
    [vendor, ORG, NOW - 7 * 86400, NOW, commits, prs, lines, accept, secs, spend, NOW]);
  await row('all', 7, 2, 100, 8, 3600, 8);
  await row('claude', 4, 2, 100, 8, 3600, 5);
  await row('openai', 3, 0, 0, 0, 0, 3);
}

async function get(vendor?: string) {
  const res = await route.GET(new NextRequest(`http://localhost/api/pulse/code/framework${vendor ? `?vendor=${vendor}` : ''}`));
  return res.json();
}
const cell = (body: { boxes: Array<{ cells: Array<{ label: string; value: string | null; fit: string; note?: string }> }> }, label: string) =>
  body.boxes.flatMap(b => b.cells).find(c => c.label === label)!;

describe('GET /api/pulse/code/framework by vendor', () => {
  it('reads Claude Code with no Codex data, whatever view is asked for', async () => {
    const body = await get('openai');
    expect(body.vendor).toBe('claude');
    expect(body.codexPresent).toBe(false);
    expect(cell(body, 'AI-assisted commits (7d)').value).toBe('4');
    expect(cell(body, 'Claude spend (context)').value).toBe('$5');
  });

  it('All reads the all-tools row', async () => {
    await seedCodex();
    const body = await get('all');
    expect(body.vendor).toBe('all');
    expect(body.codexPresent).toBe(true);
    expect(cell(body, 'AI-assisted commits (7d)').value).toBe('7');
    expect(cell(body, 'Claude and Codex spend (context)').value).toBe('$8');
    expect(cell(body, 'Merged PRs (7d)').value).toBe('2');
  });

  it('Codex reads its own row; what Codex never reports is not captured', async () => {
    await seedCodex();
    const body = await get('openai');
    expect(body.vendor).toBe('openai');
    expect(cell(body, 'AI-assisted commits (7d)').value).toBe('3');
    expect(cell(body, 'Codex spend (context)').value).toBe('$3');
    for (const label of ['Merged PRs (7d)', 'Code output (lines ±)', 'Edit acceptance rate', 'Engaged AI time (hrs, 7d)']) {
      expect(cell(body, label)).toMatchObject({ value: null, fit: 'not_captured', note: 'Codex does not report this.' });
    }
  });

  it('Claude reads Claude Code alone; hidden ChatGPT and Codex read as Claude', async () => {
    await seedCodex();
    expect(cell(await get('claude'), 'AI-assisted commits (7d)').value).toBe('4');
    await setConfigValue('openaiShown', 'false');
    const hidden = await get('openai');
    expect(hidden.vendor).toBe('claude');
    expect(hidden.codexPresent).toBe(false);
    expect(cell(hidden, 'AI-assisted commits (7d)').value).toBe('4');
  });
});

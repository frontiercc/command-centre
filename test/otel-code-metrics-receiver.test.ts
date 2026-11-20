// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let processCodeOtlpMetrics: (payload: unknown) => Promise<{
  processed: number; skipped: number; errors: string[];
}>;

const EMAIL = 'coder@example.com';
const USER_ID = 'usr_metrics01';
const SESSION = 'sess_m1';

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  const mod = await import('@/lib/otel/code-metrics-receiver');
  processCodeOtlpMetrics = mod.processCodeOtlpMetrics;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_otel_metrics`);
  await sql.run(`DELETE FROM users WHERE email = ?`, [EMAIL]);
});

/** Build an OTLP resourceMetrics payload with one sum metric + data points. */
function makeMetrics(
  name: string,
  dataPoints: Array<{ value: number; attrs?: Record<string, string>; timeUnixNano?: string }>,
  serviceName = 'claude-code',
) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeMetrics: [{
        metrics: [{
          name,
          sum: {
            dataPoints: dataPoints.map(dp => ({
              asDouble: dp.value,
              timeUnixNano: dp.timeUnixNano ?? '1750000000000000000',
              attributes: [
                { key: 'user.email', value: { stringValue: EMAIL } },
                { key: 'user.id', value: { stringValue: USER_ID } },
                { key: 'session.id', value: { stringValue: SESSION } },
                ...Object.entries(dp.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
              ],
            })),
          },
        }],
      }],
    }],
  };
}

describe('processCodeOtlpMetrics', () => {
  it('captures active_time.total with the type sub-attribute', async () => {
    const r = await processCodeOtlpMetrics(makeMetrics('claude_code.active_time.total', [
      { value: 120, attrs: { type: 'user' } },
      { value: 300, attrs: { type: 'cli' } },
    ]));
    expect(r.processed).toBe(2);
    const rows = (await sql.all(
      `SELECT type, value FROM code_otel_metrics WHERE metric_name = 'claude_code.active_time.total' ORDER BY type`
    )) as Array<{ type: string; value: number }>;
    expect(rows).toEqual([{ type: 'cli', value: 300 }, { type: 'user', value: 120 }]);
  });

  it('captures lines_of_code added/removed', async () => {
    await processCodeOtlpMetrics(makeMetrics('claude_code.lines_of_code.count', [
      { value: 80, attrs: { type: 'added' } },
      { value: 25, attrs: { type: 'removed' } },
    ]));
    const added = (await sql.get(
      `SELECT value FROM code_otel_metrics WHERE metric_name='claude_code.lines_of_code.count' AND type='added'`
    )) as { value: number };
    expect(added.value).toBe(80);
  });

  it('captures commit and pull_request counts (no sub-type)', async () => {
    await processCodeOtlpMetrics(makeMetrics('claude_code.commit.count', [{ value: 3 }]));
    await processCodeOtlpMetrics(makeMetrics('claude_code.pull_request.count', [{ value: 1 }]));
    const commits = (await sql.get(`SELECT value, type FROM code_otel_metrics WHERE metric_name='claude_code.commit.count'`)) as { value: number; type: string | null };
    expect(commits.value).toBe(3);
    expect(commits.type).toBeNull();
  });

  it('captures edit decisions with decision + language', async () => {
    await processCodeOtlpMetrics(makeMetrics('claude_code.code_edit_tool.decision', [
      { value: 1, attrs: { decision: 'accept', language: 'TypeScript' } },
      { value: 1, attrs: { decision: 'reject', language: 'Python' } },
    ]));
    const rows = (await sql.all(
      `SELECT type, language FROM code_otel_metrics WHERE metric_name='claude_code.code_edit_tool.decision' ORDER BY type`
    )) as Array<{ type: string; language: string }>;
    expect(rows).toEqual([
      { type: 'accept', language: 'TypeScript' },
      { type: 'reject', language: 'Python' },
    ]);
  });

  it('resolves an existing users row id by email', async () => {
    const now = Math.floor(Date.now() / 1000);
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at)
                VALUES (?, ?, 'Coder', 'otel', ?, ?)`, ['usr_existing', EMAIL, now, now]);
    await processCodeOtlpMetrics(makeMetrics('claude_code.commit.count', [{ value: 1 }]));
    const row = (await sql.get(`SELECT user_id FROM code_otel_metrics WHERE metric_name='claude_code.commit.count'`)) as { user_id: string };
    expect(row.user_id).toBe('usr_existing');
  });

  it('skips non-claude-code service.name', async () => {
    const r = await processCodeOtlpMetrics(makeMetrics('claude_code.commit.count', [{ value: 1 }], 'cowork'));
    expect(r.processed).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('skips metrics not on the whitelist', async () => {
    const r = await processCodeOtlpMetrics(makeMetrics('claude_code.token.usage', [{ value: 999 }]));
    expect(r.processed).toBe(0);
  });

  it('skips data points with no email', async () => {
    const payload = {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeMetrics: [{ metrics: [{ name: 'claude_code.commit.count', sum: { dataPoints: [{ asDouble: 5, attributes: [] }] } }] }],
      }],
    };
    const r = await processCodeOtlpMetrics(payload);
    expect(r.processed).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('is idempotent on a re-POSTed batch', async () => {
    const payload = makeMetrics('claude_code.active_time.total', [{ value: 120, attrs: { type: 'user' } }]);
    await processCodeOtlpMetrics(payload);
    await processCodeOtlpMetrics(payload);
    const count = (await sql.get(`SELECT COUNT(*) AS n FROM code_otel_metrics`)) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('running totals (cumulative temporality)', () => {
  const cumulative = (points: Array<{ value: number; t: number; start?: number }>) => {
    const p = makeMetrics('claude_code.code_edit_tool.decision', points.map(x => ({
      value: x.value, attrs: { decision: 'accept' }, timeUnixNano: `${x.t}000000000`,
    })));
    const m = p.resourceMetrics[0].scopeMetrics[0].metrics[0] as { sum: { aggregationTemporality?: number; dataPoints: Array<Record<string, unknown>> } };
    m.sum.aggregationTemporality = 2;
    m.sum.dataPoints.forEach((dp, i) => { dp.startTimeUnixNano = `${points[i].start ?? 1750000000}000000000`; });
    return p;
  };
  const stored = async () =>
    (await sql.all<{ value: number }>(`SELECT value FROM code_otel_metrics WHERE metric_name = 'claude_code.code_edit_tool.decision' ORDER BY occurred_at`)).map(r => Number(r.value));

  beforeEach(async () => { await sql.exec(`DELETE FROM otel_cumulative_series`); });

  it('stores the increase since the last report, across requests', async () => {
    await processCodeOtlpMetrics(cumulative([{ value: 3, t: 1750000020 }, { value: 7, t: 1750000040 }]));
    await processCodeOtlpMetrics(cumulative([{ value: 12, t: 1750000060 }]));
    expect(await stored()).toEqual([3, 4, 5]);
  });

  it('reads points oldest first even when they arrive out of order', async () => {
    await processCodeOtlpMetrics(cumulative([{ value: 7, t: 1750000040 }, { value: 3, t: 1750000020 }]));
    expect(await stored()).toEqual([3, 4]);
  });

  it('counts a restarted counter from zero', async () => {
    await processCodeOtlpMetrics(cumulative([{ value: 9, t: 1750000020 }]));
    await processCodeOtlpMetrics(cumulative([{ value: 2, t: 1750000080, start: 1750000070 }]));
    expect(await stored()).toEqual([9, 2]);
  });

  it('ignores a report already counted', async () => {
    await processCodeOtlpMetrics(cumulative([{ value: 5, t: 1750000020 }]));
    const again = await processCodeOtlpMetrics(cumulative([{ value: 5, t: 1750000020 }]));
    expect(again.skipped).toBe(1);
    expect(await stored()).toEqual([5]);
  });

  it('leaves increments from a delta client as they are', async () => {
    await processCodeOtlpMetrics(makeMetrics('claude_code.code_edit_tool.decision', [
      { value: 3, attrs: { decision: 'accept' }, timeUnixNano: '1750000020000000000' },
      { value: 2, attrs: { decision: 'accept' }, timeUnixNano: '1750000040000000000' },
    ]));
    expect(await stored()).toEqual([3, 2]);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Weekly digest and Metrics Connector with ChatGPT and Codex connected:
//  - the Code block reads the all-tools figures (Claude Code plus Codex) and
//    names each tool's spend when both had some: "Claude Code $X · Codex $Y";
//  - the time-saved line counts ChatGPT conversations;
//  - "Show ChatGPT and Codex" off brings back the Claude-only figures;
//  - the connector carries the same totals, organisation level only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let setConfigValue: typeof import('@/lib/config').setConfigValue;

const NOW = Math.floor(Date.now() / 1000);
let WEEK_START = 0;
const PERSON_ID = 'zz-person-openai-1';
const PERSON_EMAIL = 'person.openai@example.com';

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  setConfigValue = (await import('@/lib/config')).setConfigValue;
  const period = await import('@/lib/pulse/period');
  WEEK_START = period.priorWeekStart(NOW);
  const end = WEEK_START + 7 * 86400;

  await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    [PERSON_ID, PERSON_EMAIL, 'Openai Person', WEEK_START, NOW]);
  // Codex has arrived.
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at, ingested_at)
                 VALUES ('cx1', 'codex:s1', ?, 'code_user_message', 'code', 'codex', ?, ?)`, [PERSON_ID, WEEK_START + 100, WEEK_START + 100]);

  // Claude-only org row (code_metrics) and the per-product rows (code_metrics_vendor).
  await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at)
                 VALUES ('organisation', 'org', ?, ?, 'week', 100, 4, 1, 3, 7200, ?)`, [WEEK_START, end, NOW]);
  const vendorRow = (vendor: string, scopeType: string, scopeId: string, spend: number, commits: number, sessions: number) =>
    sql.run(`INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, period_start, period_end, granularity, spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at)
             VALUES (?, ?, ?, ?, ?, 'week', ?, ?, 1, ?, 7200, ?)`, [vendor, scopeType, scopeId, WEEK_START, end, spend, commits, sessions, NOW]);
  await vendorRow('all', 'organisation', 'org', 150, 6, 5);
  await vendorRow('claude', 'organisation', 'org', 100, 4, 3);
  await vendorRow('openai', 'organisation', 'org', 50, 2, 2);
  await vendorRow('all', 'user', PERSON_ID, 150, 6, 5);

  // Human time: one Claude Cowork session and one ChatGPT conversation, both estimated.
  await setConfigValue('humanTimeEnabled', 'true');
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES ('s-cw', 's-cw', ?, 'otel', ?)`, [PERSON_ID, WEEK_START + 200]);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, active_secs, human_minutes_low, human_minutes_likely, human_minutes_high, computed_at)
                 VALUES ('s-cw', ?, ?, ?, 1800, 60, 120, 180, ?)`, [PERSON_ID, WEEK_START + 200, WEEK_START + 2000, NOW]);
  await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, active_secs, human_minutes_low, human_minutes_likely, human_minutes_high, computed_at)
                 VALUES ('chatgpt:g1', ?, 'chatgpt_work', ?, ?, 1200, 30, 60, 90, ?)`, [PERSON_ID, WEEK_START + 300, WEEK_START + 1500, NOW]);
});

afterAll(async () => cleanup());

describe('weekly digest with ChatGPT and Codex', () => {
  it('reads the all-tools Code figures and splits spend by tool', async () => {
    await setConfigValue('openaiShown', 'true');
    const { buildDigest } = await import('@/lib/digest/build');
    const d = await buildDigest(NOW);
    expect(d?.code).toMatchObject({ spendUsd: 150, commits: 6, activeUsers: 1, spendByProduct: { claudeCodeUsd: 100, codexUsd: 50 } });

    const { renderDigestHtml, renderDigestSlack } = await import('@/lib/digest/render');
    expect(renderDigestHtml(d!, 'https://hub.test')).toContain('Claude Code $100.00 · Codex $50.00');
    expect(JSON.stringify(renderDigestSlack(d!, 'https://hub.test'))).toContain('Claude Code $100.00 · Codex $50.00');
  });

  it('counts ChatGPT conversations in the time-saved line', async () => {
    await setConfigValue('openaiShown', 'true');
    const { buildDigest } = await import('@/lib/digest/build');
    const d = await buildDigest(NOW);
    expect(d?.humanTime?.total).toEqual({ sessions: 2, humanMinutes: 180, claudeMinutes: 50 });
  });

  it('with ChatGPT and Codex hidden: Claude Code figures, no split, no ChatGPT time', async () => {
    await setConfigValue('openaiShown', 'false');
    const { buildDigest } = await import('@/lib/digest/build');
    const d = await buildDigest(NOW);
    expect(d?.code).toMatchObject({ spendUsd: 100, commits: 4, spendByProduct: null });
    expect(d?.humanTime?.total).toEqual({ sessions: 1, humanMinutes: 120, claudeMinutes: 30 });
    const { renderDigestHtml } = await import('@/lib/digest/render');
    expect(renderDigestHtml(d!, 'https://hub.test')).not.toContain('Codex');
    await setConfigValue('openaiShown', 'true');
  });
});

describe('Highlights and Reports human time agree with the digest', () => {
  it('Highlights counts ChatGPT conversations when shown, and leaves them out when hidden', async () => {
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    await setConfigValue('openaiShown', 'true');
    expect((await gatherHighlights({ nowS: NOW })).humanTime).toEqual({ sessions: 2, humanMinutes: 180, claudeMinutes: 50 });
    await setConfigValue('openaiShown', 'false');
    expect((await gatherHighlights({ nowS: NOW })).humanTime).toEqual({ sessions: 1, humanMinutes: 120, claudeMinutes: 30 });
    await setConfigValue('openaiShown', 'true');
  });

  it('the Reports section shows the same totals, with Claude Cowork and ChatGPT on their own lines', async () => {
    const { buildHumanTimeSection } = await import('@/lib/reports/human-time-sections');
    const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
    await setConfigValue('openaiShown', 'true');
    const md = await buildHumanTimeSection(day(WEEK_START), day(WEEK_START + 6 * 86400));
    expect(md).toContain('| Total | 2 | about 3.0 | 0.8 |');
    expect(md).toContain('| of which Claude Cowork | 1 | about 2.0 | 0.5 |');
    expect(md).toContain('| of which ChatGPT | 1 | about 1.0 | 0.3 |');
    await setConfigValue('openaiShown', 'false');
    const hidden = await buildHumanTimeSection(day(WEEK_START), day(WEEK_START + 6 * 86400));
    expect(hidden).toContain('| Total | 1 | about 2.0 | 0.5 |');
    expect(hidden).not.toContain('ChatGPT');
    await setConfigValue('openaiShown', 'true');
  });
});

describe('Metrics Connector with ChatGPT and Codex', () => {
  it('carries the digest totals, and the trend reads the same all-tools spend', async () => {
    await setConfigValue('openaiShown', 'true');
    const { getConnectorSummary, getConnectorTrend } = await import('@/lib/connector/data');
    const s = await getConnectorSummary(NOW) as { code: { spendUsd: number; spendByProduct: unknown }; humanTime: { total: { sessions: number }; cowork: { byProduct?: unknown } } };
    expect(s.code.spendUsd).toBe(150);
    expect(s.code.spendByProduct).toEqual({ claudeCodeUsd: 100, codexUsd: 50 });
    expect(s.humanTime.total.sessions).toBe(2);
    expect(s.humanTime.cowork.byProduct).toEqual({ claude: { sessions: 1, humanMinutes: 120, claudeMinutes: 30 }, openai: { sessions: 1, humanMinutes: 60, claudeMinutes: 20 } });
    const trend = await getConnectorTrend('spend_usd', 4, NOW);
    expect(trend.series.find(p => p.weekStart === WEEK_START)?.value).toBe(150);
  });

  it('carries no per-person field and no person identifier anywhere', async () => {
    await setConfigValue('openaiShown', 'true');
    const { getConnectorSummary, getConnectorTrend } = await import('@/lib/connector/data');
    const payloads = [await getConnectorSummary(NOW), await getConnectorTrend('spend_usd', 4, NOW)];
    const forbidden = new Set(['user_id', 'userId', 'users', 'email', 'display_name', 'displayName', 'name', 'person', 'people', 'owner', 'ownerUserId', 'session_id', 'sessionId']);
    const seen: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) { if (forbidden.has(k)) seen.push(k); walk(child); }
      }
    };
    payloads.forEach(walk);
    expect(seen).toEqual([]);
    const text = JSON.stringify(payloads);
    expect(text).not.toContain(PERSON_ID);
    expect(text).not.toContain(PERSON_EMAIL);
    expect(text).not.toContain('chatgpt:g1');
  });
});

describe('Metrics Connector trend beyond the all-tools weeks', () => {
  it('uses the all-tools row where a week has one and Claude Code\'s own row otherwise, with no gap', async () => {
    await setConfigValue('openaiShown', 'true');
    const { weekStarts } = await import('@/lib/pulse/period');
    const { getConnectorTrend } = await import('@/lib/connector/data');
    // The 20 weeks get_metric_trend reads: 19 completed weeks and the current one.
    const weeks = weekStarts(NOW, 20);
    // Claude Code's own org rows for every week; all-tools rows only for the
    // latest 5 completed weeks (the vendor rows are rebuilt for recent weeks only).
    const allToolsWeeks = new Set(weeks.slice(14, 19));
    const claudeValue = (i: number) => 100 + i;
    const allValue = (i: number) => 1000 + i;
    for (let i = 0; i < weeks.length; i++) {
      await sql.run(
        `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, granularity, pr_count, computed_at)
         VALUES ('organisation', 'org', ?, ?, 'week', ?, ?)
         ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity = 'week' DO UPDATE SET pr_count = excluded.pr_count`,
        [weeks[i], weeks[i] + 7 * 86400, claudeValue(i), NOW]);
      if (allToolsWeeks.has(weeks[i])) {
        await sql.run(
          `INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, period_start, period_end, granularity, pr_count, computed_at)
           VALUES ('all', 'organisation', 'org', ?, ?, 'week', ?, ?)
           ON CONFLICT (vendor, scope_type, scope_id, period_start) WHERE granularity = 'week' DO UPDATE SET pr_count = excluded.pr_count`,
          [weeks[i], weeks[i] + 7 * 86400, allValue(i), NOW]);
      }
    }

    const trend = await getConnectorTrend('pr_count', 20, NOW);
    expect(trend.series.map(p => p.weekStart)).toEqual(weeks);
    expect(trend.series.every(p => p.value !== null)).toBe(true);
    trend.series.forEach((p, i) => {
      expect(p.value).toBe(allToolsWeeks.has(p.weekStart) ? allValue(i) : claudeValue(i));
    });

    // Hidden: Claude Code's own figures for every week.
    await setConfigValue('openaiShown', 'false');
    try {
      const hidden = await getConnectorTrend('pr_count', 20, NOW);
      expect(hidden.series.map(p => p.value)).toEqual(weeks.map((_, i) => claudeValue(i)));
    } finally {
      await setConfigValue('openaiShown', 'true');
    }
  });
});

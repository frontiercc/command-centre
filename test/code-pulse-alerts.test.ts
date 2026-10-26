// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';
import type { Alert } from '@/lib/db/queries';

let sql: TestSql;
let cleanup: () => Promise<void>;
let runCodePulseAlerts: typeof import('@/lib/alerts/code-pulse-alerts').runCodePulseAlerts;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  const mod = await import('@/lib/alerts/code-pulse-alerts');
  runCodePulseAlerts = mod.runCodePulseAlerts;
  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM alerts; DELETE FROM code_assistant_meta; DELETE FROM code_session_stats;
           DELETE FROM config WHERE key LIKE 'code_alert_%' OR key LIKE 'code_cost_%' OR key LIKE 'code_friction_%' OR key LIKE 'code_sensitive_%' OR key = 'code_model_allowlist';`);
  // Migration 084 stamps the per-model-call cut-over at "now" on a fresh DB, and
  // the cost-spike check stays quiet for 7 days after it. Put the cut-over well
  // in the past so these tests exercise the normal check.
  await sql.run(`INSERT INTO config (key, value) VALUES ('code_meta_per_call_since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(Math.floor(Date.now() / 1000) - 30 * 86400)]);
  // A $25 daily limit for these tests; the default ($100) has its own test.
  await sql.run(`INSERT INTO config (key, value) VALUES ('code_cost_spike_floor_usd', '25') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
});

async function setConfig(key: string, value: string) {
  await sql.run(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
}

async function seedSpend(userId: string, model: string, inputTokens: number, occurredAt: number, id: string) {
  await sql.run(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count,
        commit_count, error_count, cwd, git_branch, occurred_at, ingested_at)
     VALUES (?, ?, 's1', ?, ?, 0, 0, 0, 'end_turn', 0, 0, 0, '', '', ?, ?)`,
    [id, userId, model, inputTokens, occurredAt, NOW],
  );
}

describe('code_cost_spike', () => {
  it('fires when 24h spend exceeds floor with no history', async () => {
    // fable-5: $10/MTok input → 3M input tokens in last 24h = $30 > $25 floor
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'cs1');
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT * FROM alerts WHERE alert_type = 'code_cost_spike'`)) as Record<string, string> | undefined;
    expect(alert).toBeDefined();
    expect(alert!.user_id).toBe('user-1');
  });

  it('does not fire below the floor', async () => {
    await seedSpend('user-1', 'claude-fable-5', 900_000, NOW - 3600, 'cs1'); // $9 < $25 floor
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_cost_spike'`))).toEqual({ c: 0 });
  });

  it('honours a custom floor from config', async () => {
    await setConfig('code_cost_spike_floor_usd', '100');
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'cs1'); // $30 < $100
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_cost_spike'`))).toEqual({ c: 0 });
  });

  it('is a fixed daily limit: a heavy usual spender over it is alerted', async () => {
    // $50 a day for the prior 14 days; $30 today is over the $25 limit. The old
    // rule (3x the usual daily spend) would not have fired.
    for (let d = 2; d <= 15; d++) {
      await seedSpend('user-1', 'claude-fable-5', 5_000_000, NOW - d * 24 * 3600, `p${d}`);
    }
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'cs1');
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_cost_spike'`))).toEqual({ c: 1 });
  });

  it('defaults to a $100 daily limit when none is set', async () => {
    await sql.run(`DELETE FROM config WHERE key = 'code_cost_spike_floor_usd'`);
    await seedSpend('user-1', 'claude-fable-5', 9_000_000, NOW - 3600, 'd1'); // $90
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_cost_spike'`))).toEqual({ c: 0 });
    await seedSpend('user-1', 'claude-fable-5', 2_000_000, NOW - 1800, 'd2'); // $110
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT severity, explanation FROM alerts WHERE alert_type='code_cost_spike'`)) as { severity: string; explanation: string };
    expect(alert.severity).toBe('medium');
    expect(alert.explanation).toContain('over the daily limit of $100.00');
  });

  it('dedupes — second run within 24h does not re-fire', async () => {
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'cs1');
    await runCodePulseAlerts();
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_cost_spike'`))).toEqual({ c: 1 });
  });

  it('respects the disable toggle', async () => {
    await setConfig('code_alert_cost_spike_enabled', 'false');
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'cs1');
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts`))).toEqual({ c: 0 });
  });
});

describe('code_model_policy', () => {
  it('fires for models off the allowlist when enabled', async () => {
    await setConfig('code_alert_model_policy_enabled', 'true');
    await setConfig('code_model_allowlist', JSON.stringify(['claude-haiku-4-5']));
    await seedSpend('user-1', 'claude-fable-5', 1000, NOW - 3600, 'mp1');
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT title FROM alerts WHERE alert_type='code_model_policy'`)) as { title: string };
    expect(alert.title).toContain('claude-fable-5');
  });

  it('stays silent with an empty allowlist (not configured)', async () => {
    await setConfig('code_alert_model_policy_enabled', 'true');
    await seedSpend('user-1', 'claude-fable-5', 1000, NOW - 3600, 'mp1');
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_model_policy'`))).toEqual({ c: 0 });
  });
});

describe('code_repo_exposure and code_friction', () => {
  async function seedSessionStats(sessionId: string, repo: string, errors: number, tools: number) {
    await sql.run(
      `INSERT INTO code_session_stats
         (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count,
          assistant_turns, tool_use_count, error_count, commit_count,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, computed_at)
       VALUES (?, 'user-1', ?, 'main', ?, ?, 1, 1, ?, ?, 0, 0, 0, 0, 0, ?)`,
      [sessionId, repo, NOW - 7200, NOW - 3600, tools, errors, NOW],
    );
  }

  it('repo exposure fires on pattern match when enabled', async () => {
    await setConfig('code_alert_repo_exposure_enabled', 'true');
    await setConfig('code_sensitive_repo_patterns', JSON.stringify(['payroll']));
    await seedSessionStats('s1', 'payroll-service', 0, 3);
    await seedSessionStats('s2', 'website', 0, 3);
    await runCodePulseAlerts();
    const alerts = (await sql.all(`SELECT title FROM alerts WHERE alert_type='code_repo_exposure'`)) as Array<{ title: string }>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain('payroll-service');
  });

  it('friction fires above threshold when enabled, not below', async () => {
    await setConfig('code_alert_friction_enabled', 'true');
    await seedSessionStats('s-bad', 'my-app', 4, 10);   // 40% > 25%
    await seedSessionStats('s-fine', 'my-app', 1, 10);  // 10%
    await runCodePulseAlerts();
    const alerts = (await sql.all(`SELECT CAST(raw_evidence AS TEXT) AS raw_evidence FROM alerts WHERE alert_type='code_friction'`)) as Array<{ raw_evidence: string }>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].raw_evidence).toContain('s-bad');
  });

  it('friction is off by default', async () => {
    await seedSessionStats('s-bad', 'my-app', 9, 10);
    await runCodePulseAlerts();
    expect((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type='code_friction'`))).toEqual({ c: 0 });
  });
});

// A high spend spike once reached Slack as
// "<64-character id> spent $127.53…". The alert stored the raw id in its text, and
// the Slack sweep sends stored text as it is (the Alerts page swaps the name
// in on read; Slack does not). The text must carry the person's name.
describe('alert text names the person, never the raw id', () => {
  const HASH = '3c9e1f0a7b2d4e6f8a1c3e5f7b9d2a4c6e8f0a1b3d5c7e9f1a2b4c6d8e0f1a3b';

  beforeEach(async () => {
    await sql.run('DELETE FROM admin_users WHERE linked_cowork_user_id = ?', [HASH]);
    await sql.run('DELETE FROM users WHERE id = ?', [HASH]);
    await seedUserSql(sql, HASH, 'jane.smith@test.local');
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Jane Smith', HASH]);
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, display_name, linked_cowork_user_id) VALUES (?, ?, 'x', 'pulse', ?, ?)`,
      ['adm-js', 'jane.smith@test.local', 'Jane Smith', HASH],
    );
  });

  it('cost spike: stored text and the Slack message name the person', async () => {
    await seedSpend(HASH, 'claude-fable-5', 3_000_000, NOW - 3600, 'cs-hash');
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT * FROM alerts WHERE alert_type = 'code_cost_spike'`)) as Alert;
    expect(alert.explanation).toMatch(/^Jane Smith spent \$30\.00 on Claude Code/);
    expect(alert.user_id).toBe(HASH);

    const { renderAlertSlack } = await import('@/lib/alerts/render-slack');
    const slack = JSON.stringify(renderAlertSlack({ ...alert, raw_evidence: null }, 'https://hub.test'));
    expect(slack).toContain('Jane Smith spent');
    expect(slack).not.toContain(HASH);
  });

  it('model policy: stored text names the person', async () => {
    await setConfig('code_alert_model_policy_enabled', 'true');
    await setConfig('code_model_allowlist', JSON.stringify(['claude-haiku-4-5']));
    await seedSpend(HASH, 'claude-fable-5', 1000, NOW - 3600, 'mp-hash');
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT explanation FROM alerts WHERE alert_type = 'code_model_policy'`)) as { explanation: string };
    expect(alert.explanation).toBe('Jane Smith used model "claude-fable-5", which is not on the approved model list.');
  });
});

// A spike is usually caught in the hour it first crosses the threshold (medium,
// not sent to Slack); the 24-hour dedup used to hide it however high it went.
// A medium spike now steps up to high (which the Slack sweep sends) once it
// passes twice the threshold inside those 24 hours.
describe('spend alert steps up from medium to high', () => {
  async function spikes() {
    return (await sql.all(`SELECT severity FROM alerts WHERE alert_type = 'code_cost_spike' ORDER BY generated_at, severity DESC`)) as Array<{ severity: string }>;
  }

  it('raises a high alert when a medium spike passes twice the threshold within 24h, then stays quiet', async () => {
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'su1'); // $30 > $25: medium
    await runCodePulseAlerts();
    expect((await spikes()).map(a => a.severity)).toEqual(['medium']);

    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 1800, 'su2'); // $60 > $50: high
    await runCodePulseAlerts();
    expect((await spikes()).map(a => a.severity).sort()).toEqual(['high', 'medium']);

    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 900, 'su3'); // $90: already high today
    await runCodePulseAlerts();
    expect(await spikes()).toHaveLength(2);
  });

  it('does not raise a second medium alert within 24h', async () => {
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, NOW - 3600, 'sm1'); // $30
    await runCodePulseAlerts();
    await seedSpend('user-1', 'claude-fable-5', 1_000_000, NOW - 1800, 'sm2'); // $40, still under $50
    await runCodePulseAlerts();
    expect((await spikes()).map(a => a.severity)).toEqual(['medium']);
  });
});

describe('cost spike wording names the window and the month so far', () => {
  it('formats the 24-hour window and the month-to-date figure', async () => {
    const { costSpikeExplanation } = await import('@/lib/alerts/code-pulse-alerts');
    const text = costSpikeExplanation({
      who: 'Jane Smith', spend24: 127.53, windowEnd: Date.UTC(2026, 9, 7, 21, 38) / 1000,
      monthToDate: 179.63, dailyLimit: 100,
    });
    expect(text).toBe('Jane Smith spent $127.53 on Claude Code in the 24 hours to 7 Oct, 21:38 UTC (October so far: $179.63), '
      + 'over the daily limit of $100.00. Could be a heavy work burst or a runaway loop worth a look.');
  });

  it('the month figure counts this calendar month (UTC), including spend before the 24-hour window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const d = new Date(now * 1000);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const earlierThisMonth = now - 36 * 3600 >= monthStart; // false on the 1st and early on the 2nd
    if (earlierThisMonth) await seedSpend('user-1', 'claude-fable-5', 1_000_000, now - 36 * 3600, 'mtd-old'); // $10
    await seedSpend('user-1', 'claude-fable-5', 3_000_000, now - 3600, 'mtd-new'); // $30
    await runCodePulseAlerts();
    const alert = (await sql.get(`SELECT explanation FROM alerts WHERE alert_type = 'code_cost_spike'`)) as { explanation: string };
    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()];
    expect(alert.explanation).toContain(`spent $30.00 on Claude Code in the 24 hours to `);
    expect(alert.explanation).toContain(`(${month} so far: $${earlierThisMonth ? '40.00' : '30.00'})`);
  });
});

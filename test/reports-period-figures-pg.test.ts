// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Report figures read for the report period: the Work Pulse section from the
// person and department rows the Executive View reads (no organisation-wide
// row is ever written), and personal-data detections counting only
// personal-data matches inside the period.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const START = '2026-10-01';
const END = '2026-10-31';
const IN = Math.floor(Date.UTC(2026, 9, 15) / 1000);
const LAST_DAY = Math.floor(Date.UTC(2026, 9, 31, 12) / 1000);
const AFTER = Math.floor(Date.UTC(2026, 10, 2) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local'), ('u2', 'u2@test.local')`);
  const metric = (scopeType: string, scopeId: string, granularity: string, periodStart: number, computedAt: number, cols: Record<string, number>) => sql.run(
    `INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, computed_at, granularity, metric_version, ${Object.keys(cols).join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, 2, ${Object.keys(cols).map(() => '?').join(', ')})`,
    [scopeType, scopeId, periodStart, periodStart + 7 * 86400, computedAt, granularity, ...Object.values(cols)]);
  const NOW = Math.floor(Date.now() / 1000);
  // Delegation depth: weekly rows for weeks starting in the period.
  await metric('user', 'u1', 'week', IN, NOW, { dds: 2 });
  await metric('user', 'u2', 'week', IN, NOW, { dds: 3 });
  await metric('user', 'u1', 'week', AFTER, NOW, { dds: 9 });                 // a week after the period: not read
  // More valuable work and resilience: current rolling rows only.
  await metric('user', 'u1', 'rolling', NOW - 7 * 86400, NOW, { oti: 1.0 });
  await metric('user', 'u2', 'rolling', NOW - 7 * 86400, NOW, { oti: 1.4 });
  await metric('function', 'Sales', 'rolling', NOW - 7 * 86400, NOW, { ors: 0.6, ors_breadth: 0.5, ors_overlap: 0.4, ors_propagation: 0.3 });
  await metric('function', 'Legal', 'rolling', NOW - 7 * 86400, NOW, { ors: 0.8, ors_breadth: 0.7, ors_overlap: 0.6, ors_propagation: 0.5 });

  const prompt = async (id: string, at: number, tier: number, flag: string | null) => {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, flagged, flag_reason)
      VALUES (?, ?, 'u1', 'cowork_user_message', 'cowork', ?, ?, ?)`, [id, `s-${id}`, at, flag ? 1 : 0, flag]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
      VALUES (?, 'u1', ?, 'analysis', 0.9, 'test', ?)`, [id, tier, at]);
  };
  await prompt('p1', IN, 3, 'PII detected: email');
  await prompt('p2', LAST_DAY, 2, 'PII detected: nino (dismissed) | Intent detected: shadow_it (high)');
  await prompt('p3', IN, 1, 'Intent detected: shadow_it (high)');      // intent only: not personal data
  await prompt('p4', AFTER, 3, 'PII detected: iban');                   // after the period
});
afterAll(async () => cleanup());

describe('report figures for the period', () => {
  it('Work Pulse reads the people and departments rows, in the period, with plain names', async () => {
    const { buildCoworkPulseSection } = await import('@/lib/reports/cowork-pulse-sections');
    const md = await buildCoworkPulseSection(START, END);
    expect(md).toContain('| More valuable work (output against each person\'s baseline; 1.2 is a meaningful uplift) | 1.20 |');
    expect(md).toContain('| Delegation depth (average tier handed to AI) | 2.50 |');
    expect(md).toContain('| Resilience (how widely capability is shared; 0.7 means organisation-owned) | 0.70 |');
    expect(md).toContain('| Tier 3 | 1 | 33% |');
    expect(md).toContain('Classified messages in window: 3.');
    expect(md).toContain('so they cover the 7 days to');
    expect(md).not.toMatch(/\b(DDS|OTI|PSR|ORS)\b/);
  });

  it('personal-data detections count personal-data matches only, to the end of the last day', async () => {
    const { buildGdprSection } = await import('@/lib/reports/compliance-sections');
    expect(await buildGdprSection(START, END)).toContain('2 detections in period');
  });
});

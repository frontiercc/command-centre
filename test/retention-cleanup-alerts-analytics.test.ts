// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Alerts (closed-only, open/active always survive regardless of
// age) + analytics_snapshots (snapshot_date is a DATE STRING, not epoch —
// the cutoff must be computed as a date string too) + the new
// CleanupResult.{alerts,analytics}_rows_affected counts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;
const dateDaysAgo = (d: number) => new Date((NOW - d * 86400) * 1000).toISOString().slice(0, 10);

describe('retention cleanup — alerts + analytics', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionMode', 'strip');
    await cfg.setConfigValue('archiveEnabled', 'false');
    await cfg.setConfigValue('retentionAlertsDays', '30');
    await cfg.setConfigValue('retentionAnalyticsDays', '30');
  });
  afterEach(async () => { await cleanup(); });

  it('deletes resolved/dismissed alerts past cutoff but keeps OPEN ones regardless of age', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.alerts).values([
      { id: 'a-res', alert_type: 'anomaly', severity: 'low', title: 't', explanation: 'e', status: 'resolved', generated_at: daysAgo(45) },
      { id: 'a-dis', alert_type: 'anomaly', severity: 'low', title: 't', explanation: 'e', status: 'dismissed', generated_at: daysAgo(45) },
      { id: 'a-open', alert_type: 'anomaly', severity: 'low', title: 't', explanation: 'e', status: 'open', generated_at: daysAgo(120) },
      { id: 'a-res-new', alert_type: 'anomaly', severity: 'low', title: 't', explanation: 'e', status: 'resolved', generated_at: daysAgo(5) },
    ] as never);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const res = await runRetentionCleanup();

    const ids = (await client.select().from(schema.alerts)).map((r: { id: string }) => r.id);
    expect(ids).toContain('a-open');       // open survives even at 120d
    expect(ids).toContain('a-res-new');    // resolved but within window survives
    expect(ids).not.toContain('a-res');    // resolved past 30d deleted
    expect(ids).not.toContain('a-dis');    // dismissed past 30d deleted
    expect(res.alerts_rows_affected).toBe(2);
  });

  it('deletes analytics_snapshots older than the date-string cutoff', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.analyticsSnapshots).values([
      { id: 'snap-old', user_id: null, snapshot_date: dateDaysAgo(45) },
      { id: 'snap-new', user_id: null, snapshot_date: dateDaysAgo(5) },
    ] as never);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const res = await runRetentionCleanup();

    const dates = (await client.select().from(schema.analyticsSnapshots)).map((r: { snapshot_date: string }) => r.snapshot_date);
    expect(dates).toContain(dateDaysAgo(5));
    expect(dates).not.toContain(dateDaysAgo(45));
    expect(res.analytics_rows_affected).toBe(1);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Alerts group of lib/db/queries.ts:
// insertAlert, getAlerts, getAlertById, getOpenAlertCount, getOpenAlertsBySeverity,
// getRecentAlerts, getLatestAlertTimestamp, hasRecentAlertForUserAndType,
// updateAlertStatus, bulkUpdateAlertStatus, deleteClosedAlerts, getUserAlerts,
// getAllUserOpenAlertCounts, getSecurityMetrics.
//
// This group is the first heavy user of Policy A (jsonb read/write
// normalisation via lib/db/json.ts's jsonToText/textToJsonValue): alerts.
// raw_evidence is `jsonb`. The central assertion this file proves is the
// ROUND TRIP — write a JSON string in, read the SAME JSON string back out —
// plus getSecurityMetrics' `->>'` category extraction and every count coming
// back as a real `number`.
//
// HARNESS RULE (copied from queries-users-pg.test.ts): queries.ts reaches
// the database through getClient(), which binds to DATABASE_URL on first
// use, so the module-under-test (and schema) are DYNAMIC-imported
// AFTER createTestDbClient() has set DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const {
      insertAlert, getAlerts, getAlertById, getOpenAlertCount, getOpenAlertsBySeverity,
      getRecentAlerts, getLatestAlertTimestamp, hasRecentAlertForUserAndType,
      updateAlertStatus, bulkUpdateAlertStatus, deleteClosedAlerts, getUserAlerts,
      getAllUserOpenAlertCounts, getSecurityMetrics,
    } = queries;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local', department: 'Eng' },
      { id: 'user-2', email: 'u2@test.local', department: 'Sales' },
      { id: 'user-3', email: 'u3@test.local' },
    ]);

    // ── insertAlert (Policy A write) ────────────────────────────────────
    // alert-1/2/3 carry real raw_evidence JSON strings (the round-trip
    // proof); alert-4/5/6 carry null to prove the null path stays null
    // too.
    await insertAlert({
      id: 'alert-1', user_id: 'user-1', alert_type: 'policy', severity: 'high',
      title: 'PII', explanation: 'exp', raw_evidence: JSON.stringify({ pii_type: 'email' }),
    });
    await insertAlert({
      id: 'alert-2', user_id: 'user-2', alert_type: 'intent', severity: 'medium',
      title: 'Intent A', explanation: 'exp', raw_evidence: JSON.stringify({ intent_category: 'data_exfiltration' }),
    });
    await insertAlert({
      id: 'alert-3', user_id: 'user-2', alert_type: 'intent', severity: 'medium',
      title: 'Intent B', explanation: 'exp', raw_evidence: JSON.stringify({ intent_category: 'data_exfiltration' }),
    });
    await insertAlert({
      id: 'alert-4', user_id: 'user-1', alert_type: 'anomaly', severity: 'low',
      title: 'Anomaly', explanation: 'exp', raw_evidence: null,
    });
    await insertAlert({
      id: 'alert-5', user_id: 'user-3', alert_type: 'policy', severity: 'critical',
      title: 'Critical', explanation: 'exp', raw_evidence: null,
    });
    await insertAlert({
      id: 'alert-6', user_id: null, alert_type: 'risk', severity: 'medium',
      title: 'Org risk', explanation: 'exp', raw_evidence: null,
    });
    // Pre-resolve alert-5 so getSecurityMetrics has a resolved-this-week row.
    await updateAlertStatus('alert-5', 'resolved', 'admin-1');

    // ── Policy A round trip: write a JSON string, read the SAME string back ──
    const a1 = await getAlertById('alert-1');
    expect(a1?.raw_evidence).toBe(JSON.stringify({ pii_type: 'email' }));
    expect(typeof a1?.raw_evidence).toBe('string');
    // A second parse must still work — proves it's real JSON text, not a
    // double-encoded string (the pg jsonb write-inverse landmine).
    expect(JSON.parse(a1!.raw_evidence!)).toEqual({ pii_type: 'email' });

    const a4 = await getAlertById('alert-4');
    expect(a4?.raw_evidence).toBeNull();

    expect(await getAlertById('does-not-exist')).toBeUndefined();

    // ── getAlerts: no filter / status filter / department filter (JOIN) ──
    expect((await getAlerts()).length).toBe(6);
    expect((await getAlerts({ status: 'open' })).length).toBe(5);
    expect((await getAlerts('open')).length).toBe(5); // string-shorthand form
    const engAlerts = await getAlerts({ department: 'Eng' });
    expect(engAlerts.map((a) => a.id).sort()).toEqual(['alert-1', 'alert-4']);

    // ── getRecentAlerts ──────────────────────────────────────────────────
    expect((await getRecentAlerts(3)).length).toBe(3);
    expect((await getRecentAlerts(100)).length).toBe(6);

    // ── getUserAlerts: round trip holds per-user too ────────────────────
    const user1Alerts = await getUserAlerts('user-1');
    expect(user1Alerts.map((a) => a.id).sort()).toEqual(['alert-1', 'alert-4']);
    const user1Alert1 = user1Alerts.find((a) => a.id === 'alert-1');
    expect(user1Alert1?.raw_evidence).toBe(JSON.stringify({ pii_type: 'email' }));

    // ── getLatestAlertTimestamp ──────────────────────────────────────────
    const latest = await getLatestAlertTimestamp();
    expect(typeof latest).toBe('number');
    expect(latest).toBeGreaterThan(0);

    // ── hasRecentAlertForUserAndType (isNull()/eq() branch) ──
    expect(await hasRecentAlertForUserAndType('user-1', 'policy')).toBe(true);
    expect(await hasRecentAlertForUserAndType('user-1', 'risk')).toBe(false);
    expect(await hasRecentAlertForUserAndType(null, 'risk')).toBe(true);
    expect(await hasRecentAlertForUserAndType(null, 'policy')).toBe(false);

    // ── getOpenAlertCount / getOpenAlertsBySeverity (Policy B: Number()) ──
    const openCount = await getOpenAlertCount();
    expect(openCount).toBe(5);
    expect(typeof openCount).toBe('number');

    const bySeverity = await getOpenAlertsBySeverity();
    expect(bySeverity).toEqual({ low: 1, medium: 3, high: 1, critical: 0 });
    for (const v of Object.values(bySeverity)) expect(typeof v).toBe('number');

    // ── getAllUserOpenAlertCounts: null user_id excluded, resolved excluded ──
    const openMap = await getAllUserOpenAlertCounts();
    expect(openMap.get('user-1')).toBe(2);
    expect(openMap.get('user-2')).toBe(2);
    expect(openMap.has('user-3')).toBe(false); // alert-5 (user-3's only alert) is resolved
    for (const v of openMap.values()) expect(typeof v).toBe('number');

    // ── getSecurityMetrics: pii_type/intent_category extraction ──
    const metrics = await getSecurityMetrics();
    expect(metrics.openAlerts).toBe(5);
    expect(metrics.resolvedThisWeek).toBe(1);
    expect(metrics.newThisWeek).toBe(6);
    expect(metrics.severityHigh).toBe(1);
    expect(metrics.severityMedium).toBe(3);
    expect(metrics.severityLow).toBe(1);
    expect(metrics.severityCritical).toBe(0);
    // Two 'data_exfiltration' intent alerts outnumber the one 'email' pii
    // alert, so that's the winning category — proves the COALESCE(`->>`)
    // extraction + GROUP BY-on-expression fix works, not just "doesn't
    // crash".
    expect(metrics.topCategory).toBe('data_exfiltration');
    expect(metrics.topCategoryCount).toBe(2);
    expect(metrics.topCategoryType).toBe('intent');
    for (const v of [metrics.openAlerts, metrics.resolvedThisWeek, metrics.newThisWeek, metrics.topCategoryCount]) {
      expect(typeof v).toBe('number');
    }

    // ── updateAlertStatus / bulkUpdateAlertStatus (rowsAffected) / deleteClosedAlerts ──
    await updateAlertStatus('alert-6', 'acknowledged');
    const ackAlert = await getAlertById('alert-6');
    expect(ackAlert?.status).toBe('acknowledged');
    expect(ackAlert?.resolved_at).toBeNull(); // 'acknowledged' isn't a terminal status

    await updateAlertStatus('alert-4', 'dismissed', 'admin-2');
    const dismissedAlert = await getAlertById('alert-4');
    expect(dismissedAlert?.status).toBe('dismissed');
    expect(dismissedAlert?.resolved_by).toBe('admin-2');
    expect(typeof dismissedAlert?.resolved_at).toBe('number');

    // 4 alerts still 'open' at this point: alert-1, alert-2, alert-3 (+ the
    // already-acknowledged alert-6 and dismissed alert-4 and resolved alert-5
    // are NOT 'open').
    const bulkUpdated = await bulkUpdateAlertStatus('open', 'resolved', 'admin-3');
    expect(bulkUpdated).toBe(3);
    expect(typeof bulkUpdated).toBe('number');
    expect(await getOpenAlertCount()).toBe(0);

    // Closed set is now: alert-1/2/3 (resolved), alert-4 (dismissed), alert-5
    // (resolved) = 5. alert-6 (acknowledged) is NOT closed.
    const deletedCount = await deleteClosedAlerts();
    expect(deletedCount).toBe(5);
    expect(typeof deletedCount).toBe('number');
    expect((await getAlerts()).map((a) => a.id)).toEqual(['alert-6']);
  } finally {
    await cleanup();
  }
}

describe('alerts (postgres)', () => {
  it(
    'insertAlert/getAlerts/getSecurityMetrics/status updates behave correctly on postgres — proves the raw_evidence round trip + ->> extraction',
    async () => {
      await runSpec();
    },
    180_000,
  );
});

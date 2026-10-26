// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Hourly sweep of the alerts table for high-priority Slack notification.
 * Deliberately source-agnostic — reads the alerts table directly rather
 * than hooking any generator's insert call, so it covers every alert
 * source (the 6 deterministic generators, the LLM anomaly detector in
 * lib/anthropic/ai.ts, and any future one) with zero per-source wiring.
 *
 * The data cursor (alertsSlackSweepCursor) always advances past whatever
 * was examined this run, independent of alertsSlackEnabled — notifyAlertSlack
 * itself decides whether a considered alert is actually pushed. This means
 * turning the feature on later never retroactively floods the channel with
 * a backlog; only alerts generated from that point forward are ever seen.
 */
import { and, gte, inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { notifyAlertSlack } from '@/lib/alerts/notify-slack';
import type { Alert } from '@/lib/db/queries';

const HOUR = 60 * 60;

// Caps how many rows a single sweep will notify. Without this, an instance
// down for a while (flag on) or a burst hour of high/critical alerts could
// return dozens of rows, each posted with up to postToSlackWebhook's 5s
// timeout — holding the shared scheduler's runCycle for minutes and delaying
// every job after it. The cursor still advances to the last EXAMINED row's
// generated_at + 1 (not the last qualifying row overall), so a backlog larger
// than this cap simply drains gradually over multiple hourly cycles.
const SWEEP_BATCH_LIMIT = 50;

async function getHighPriorityAlertsSince(cursor: number): Promise<Alert[]> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db
    .select()
    .from(a)
    .where(and(inArray(a.severity, ['high', 'critical']), gte(a.generated_at, cursor)))
    .orderBy(a.generated_at)
    .limit(SWEEP_BATCH_LIMIT);
  // raw_evidence is deliberately overwritten to null (never forwarded from
  // the DB row) rather than relying on renderAlertSlack simply not reading
  // it — this makes "the sweep never lets raw_evidence reach the notifier" a
  // structural guarantee, not an accident of what the renderer happens to
  // ignore.
  return rows.map(r => ({ ...r, raw_evidence: null })) as Alert[];
}

export async function runAlertSlackSweepJob(now: number = Math.floor(Date.now() / 1000)): Promise<{ swept: number }> {
  const lastRun = await getConfigValue('alertsSlackSweepLastRun');
  if (lastRun && Number(lastRun) > now - HOUR) {
    return { swept: 0 };
  }

  const cursorRaw = await getConfigValue('alertsSlackSweepCursor');

  if (!cursorRaw) {
    // First run: bootstrap to now rather than backfilling history — enabling
    // the feature must never retroactively flood the channel.
    await setConfigValue('alertsSlackSweepCursor', String(now));
    await setConfigValue('alertsSlackSweepLastRun', String(now));
    return { swept: 0 };
  }

  const rows = await getHighPriorityAlertsSince(Number(cursorRaw));

  for (const alert of rows) {
    await notifyAlertSlack(alert);
  }

  if (rows.length > 0) {
    const maxGeneratedAt = Math.max(...rows.map(r => r.generated_at));
    await setConfigValue('alertsSlackSweepCursor', String(maxGeneratedAt + 1));
  }
  await setConfigValue('alertsSlackSweepLastRun', String(now));

  return { swept: rows.length };
}

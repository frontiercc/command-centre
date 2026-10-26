// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Compliance sync job wrapper — interval-gated coordinator over
// runChatSync + runActivitySync. Interval gate is skipped
// entirely with `force: true` (used by the admin test button + trigger
// route). Stats are honest: `assistantMeta` counts ATTEMPTED inserts (not
// net-new rows) — same semantic as runChatSync's own return.
//
// The Activity Feed sync is gated
// behind `complianceActivitySyncEnabled` (default 'false'): a sample
// found 126/260 audit rows were CCC's own 5-min Compliance API polling,
// logged by Anthropic as `compliance_api_accessed` activity events and
// re-ingested by this job. Chat sync (prompts/connectors) is unaffected and
// always runs. When the flag is off, runActivitySync is never invoked and
// the stats JSON reports a valid zeroed shape (never a broken/missing key).
import { getConfigValue, setConfigValue } from '@/lib/config';
import { runChatSync } from './chat-sync';
import { runActivitySync } from './activity-sync';

export async function runComplianceSyncJob(opts?: { force?: boolean }) {
  // No Compliance Access Key configured -> there is nothing to sync, and
  // writing complianceLastSyncAt/complianceLastSyncStats here would resurrect
  // that bookkeeping the moment an admin Removes the key (DELETE /api/config/secret
  // deletes both alongside it). Bail out before any config write.
  const accessKey = await getConfigValue('complianceAccessKey');
  if (!accessKey) {
    return { skipped: true, chat: null, activity: null };
  }
  // 2 minutes, not 5. Anthropic's Compliance limit is 600 requests per
  // MINUTE, so syncing more often is strictly safer than raising
  // complianceChatsPerRun: a bigger run is one bigger burst against a
  // per-minute budget, whereas a shorter interval leaves the peak rate
  // (~202 requests/run) unchanged and still multiplies throughput.
  const intervalMin = parseInt(await getConfigValue('complianceSyncIntervalMinutes') || '2', 10) || 2;
  const lastAt = parseInt(await getConfigValue('complianceLastSyncAt') || '0', 10) || 0;
  const nowS = Math.floor(Date.now() / 1000);
  if (!opts?.force && nowS - lastAt < intervalMin * 60) {
    return { skipped: true, chat: null, activity: null };
  }
  const chat = await runChatSync();
  const activitySyncEnabled = (await getConfigValue('complianceActivitySyncEnabled')) === 'true';
  const activity = activitySyncEnabled
    ? await runActivitySync()
    : { activities: 0, errors: [] as string[] };
  await setConfigValue('complianceLastSyncAt', String(nowS));
  await setConfigValue('complianceLastSyncStats', JSON.stringify({
    chatsProcessed: chat.chatsProcessed, prompts: chat.prompts,
    assistantMeta: chat.assistantMeta, connectors: chat.connectors,
    activities: activity.activities,
    errors: [...chat.errors, ...activity.errors],
  }));
  return { skipped: false, chat, activity };
}

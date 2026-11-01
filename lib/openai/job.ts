// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OpenAI sync job: interval-gated wrapper over runOpenAiSync, with the
// last-sync time and figures the admin page shows. Does nothing, and writes
// nothing, until an admin key and a workspace ID are saved.
import { getConfigValue, setConfigValue } from '@/lib/config';
import { runOpenAiSync, type OpenAiSyncStats, type RunOptions } from './sync';
import { rollupChatgptSessionTime } from '@/lib/pulse/chatgpt-session-time';

/** OpenAI writes a file about every 10 minutes, so checking every 5 is plenty. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

export async function runOpenAiSyncJob(opts?: { force?: boolean } & RunOptions): Promise<{ skipped: boolean; stats: OpenAiSyncStats | null }> {
  const apiKey = await getConfigValue('openaiAdminApiKey');
  const workspaceId = (await getConfigValue('openaiWorkspaceId')).trim();
  if (!apiKey || !workspaceId) return { skipped: true, stats: null };

  const intervalRaw = parseInt(await getConfigValue('openaiSyncIntervalMinutes') || '', 10);
  const intervalMin = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_SYNC_INTERVAL_MINUTES;
  const lastAt = parseInt(await getConfigValue('openaiLastSyncAt') || '0', 10) || 0;
  const nowS = Math.floor(Date.now() / 1000);
  if (!opts?.force && nowS - lastAt < intervalMin * 60) return { skipped: true, stats: null };

  const stats = await runOpenAiSync(opts);
  // ChatGPT conversation times, which Use Cases (judging, hours) and human time
  // read, kept current as prompts and replies arrive. Never fails the sync.
  if (Object.values(stats.prompts).some((n) => n > 0)) await rollupChatgptSessionTime(nowS).catch(() => 0);
  await setConfigValue('openaiLastSyncAt', String(nowS));
  await setConfigValue('openaiLastSyncStats', JSON.stringify(stats));
  return { skipped: false, stats };
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
// Config values are read from an in-memory map so each test can set only
// what it needs; unset keys resolve to '' (mirrors getConfigValue's contract
// and the pattern in test/digest-scheduler.test.ts).
const configStore: Record<string, string> = {};
const setConfigValueMock = vi.fn((key: string, value: string) => {
  configStore[key] = value;
});

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
  setConfigValue: (...args: [string, string]) => setConfigValueMock(...args),
}));

const runChatSyncMock = vi.fn();
vi.mock('@/lib/compliance/chat-sync', () => ({
  runChatSync: (...args: unknown[]) => runChatSyncMock(...args),
}));

const runActivitySyncMock = vi.fn();
vi.mock('@/lib/compliance/activity-sync', () => ({
  runActivitySync: (...args: unknown[]) => runActivitySyncMock(...args),
}));

let runComplianceSyncJob: typeof import('../lib/compliance/job').runComplianceSyncJob;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  // Default: a key is configured so the pre-existing gate/write tests exercise
  // the sync path unchanged. Tests for the no-key bail-out unset this explicitly.
  configStore['complianceAccessKey'] = 'sk-ant-api01-test';
  setConfigValueMock.mockClear();
  runChatSyncMock.mockReset();
  runActivitySyncMock.mockReset();
  runChatSyncMock.mockResolvedValue({ chatsProcessed: 3, prompts: 7, assistantMeta: 5, connectors: 2, errors: [] });
  runActivitySyncMock.mockResolvedValue({ activities: 11, errors: [] });

  const mod = await import('../lib/compliance/job');
  runComplianceSyncJob = mod.runComplianceSyncJob;
});

describe('runComplianceSyncJob', () => {
  it('skips (interval gate) when the last sync was within the configured interval', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    configStore['complianceSyncIntervalMinutes'] = '5';
    configStore['complianceLastSyncAt'] = String(nowS - 60); // 1 minute ago, < 5 min interval

    const result = await runComplianceSyncJob();

    expect(result).toEqual({ skipped: true, chat: null, activity: null });
    expect(runChatSyncMock).not.toHaveBeenCalled();
    expect(runActivitySyncMock).not.toHaveBeenCalled();
  });

  // Default cadence: 2 minutes, not 5. Anthropic's limit is per MINUTE, so
  // syncing more often beats raising complianceChatsPerRun — same peak
  // request rate (~202/run), 2.5x the throughput.
  it('defaults to a 2-minute interval when none is configured', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    delete configStore['complianceSyncIntervalMinutes'];

    // 90s ago: inside a 2-minute window -> must skip.
    configStore['complianceLastSyncAt'] = String(nowS - 90);
    expect(await runComplianceSyncJob()).toEqual({ skipped: true, chat: null, activity: null });
    expect(runChatSyncMock).not.toHaveBeenCalled();

    // 150s ago: past 2 minutes -> must run (would still skip under the old 5).
    configStore['complianceLastSyncAt'] = String(nowS - 150);
    const ran = await runComplianceSyncJob();
    expect(ran.skipped).toBe(false);
    expect(runChatSyncMock).toHaveBeenCalledTimes(1);
  });

  it('force: true bypasses the interval gate', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    configStore['complianceSyncIntervalMinutes'] = '5';
    configStore['complianceLastSyncAt'] = String(nowS - 60); // would otherwise skip
    configStore['complianceActivitySyncEnabled'] = 'true';

    const result = await runComplianceSyncJob({ force: true });

    expect(result.skipped).toBe(false);
    expect(runChatSyncMock).toHaveBeenCalledTimes(1);
    expect(runActivitySyncMock).toHaveBeenCalledTimes(1);
  });

  it('writes complianceLastSyncAt and complianceLastSyncStats after a run', async () => {
    const before = Math.floor(Date.now() / 1000);
    configStore['complianceActivitySyncEnabled'] = 'true';

    await runComplianceSyncJob({ force: true });

    const writtenAt = parseInt(configStore['complianceLastSyncAt'], 10);
    expect(writtenAt).toBeGreaterThanOrEqual(before);

    const stats = JSON.parse(configStore['complianceLastSyncStats']);
    expect(stats.chatsProcessed).toBe(3);
    expect(stats.prompts).toBe(7);
    expect(stats.assistantMeta).toBe(5);
    expect(stats.connectors).toBe(2);
    expect(stats.activities).toBe(11);
    expect(stats.errors).toEqual([]);
  });

  it('merges errors from both sub-syncs into the stats', async () => {
    runChatSyncMock.mockResolvedValue({ chatsProcessed: 0, prompts: 0, assistantMeta: 0, connectors: 0, errors: ['chat boom'] });
    runActivitySyncMock.mockResolvedValue({ activities: 0, errors: ['activity boom'] });
    configStore['complianceActivitySyncEnabled'] = 'true';

    await runComplianceSyncJob({ force: true });

    const stats = JSON.parse(configStore['complianceLastSyncStats']);
    expect(stats.errors).toEqual(['chat boom', 'activity boom']);
  });

  it('returns skipped and writes nothing when no Compliance Access Key is configured', async () => {
    // complianceAccessKey unset -> resolves to '' -> job bails out before the
    // interval gate and before any config write.
    delete configStore['complianceAccessKey'];

    const result = await runComplianceSyncJob();

    expect(result).toEqual({ skipped: true, chat: null, activity: null });
    expect(runChatSyncMock).not.toHaveBeenCalled();
    expect(runActivitySyncMock).not.toHaveBeenCalled();
    expect(configStore['complianceLastSyncAt']).toBeUndefined();
    expect(configStore['complianceLastSyncStats']).toBeUndefined();
  });

  it('bails out even with force: true when no Compliance Access Key is configured', async () => {
    delete configStore['complianceAccessKey'];

    const result = await runComplianceSyncJob({ force: true });

    expect(result).toEqual({ skipped: true, chat: null, activity: null });
    expect(runChatSyncMock).not.toHaveBeenCalled();
    expect(setConfigValueMock).not.toHaveBeenCalled();
  });

  describe('activity sync gate (complianceActivitySyncEnabled)', () => {
    it('does not call runActivitySync when the flag is unset (default off)', async () => {
      const result = await runComplianceSyncJob({ force: true });

      expect(runActivitySyncMock).not.toHaveBeenCalled();
      expect(result.activity).toEqual({ activities: 0, errors: [] });
      // Chat sync is unaffected by the activity gate.
      expect(runChatSyncMock).toHaveBeenCalledTimes(1);
      const stats = JSON.parse(configStore['complianceLastSyncStats']);
      expect(stats.activities).toBe(0);
    });

    it('does not call runActivitySync when the flag is explicitly "false"', async () => {
      configStore['complianceActivitySyncEnabled'] = 'false';

      const result = await runComplianceSyncJob({ force: true });

      expect(runActivitySyncMock).not.toHaveBeenCalled();
      expect(result.activity).toEqual({ activities: 0, errors: [] });
    });

    it('calls runActivitySync when the flag is "true"', async () => {
      configStore['complianceActivitySyncEnabled'] = 'true';

      const result = await runComplianceSyncJob({ force: true });

      expect(runActivitySyncMock).toHaveBeenCalledTimes(1);
      expect(result.activity).toEqual({ activities: 11, errors: [] });
    });
  });
});

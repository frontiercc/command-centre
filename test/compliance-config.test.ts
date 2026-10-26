// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { CONFIG_KEYS } from '@/lib/config';

describe('compliance config keys', () => {
  it('registers all compliance keys with snake_case DB names', () => {
    expect(CONFIG_KEYS.complianceAccessKey).toBe('compliance_access_key');
    expect(CONFIG_KEYS.complianceSyncIntervalMinutes).toBe('compliance_sync_interval_minutes');
    expect(CONFIG_KEYS.complianceBackfillDays).toBe('compliance_backfill_days');
    expect(CONFIG_KEYS.complianceChatsPerRun).toBe('compliance_chats_per_run');
    expect(CONFIG_KEYS.complianceChatCursor).toBe('compliance_chat_cursor');
    expect(CONFIG_KEYS.complianceActivityCursor).toBe('compliance_activity_cursor');
    expect(CONFIG_KEYS.complianceLastSyncAt).toBe('compliance_last_sync_at');
    expect(CONFIG_KEYS.complianceLastSyncStats).toBe('compliance_last_sync_stats');
  });
});

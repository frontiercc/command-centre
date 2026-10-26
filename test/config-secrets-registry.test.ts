// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Structural guarantee: every masked sensitive key has a removal definition,
// so a future secret cannot dodge the Remove path.
import { describe, it, expect } from 'vitest';
import { SECRET_KEYS, SENSITIVE_KEYS } from '@/lib/config-secrets';

describe('config-secrets registry', () => {
  it('covers all 13 sensitive keys', () => {
    expect(new Set(SENSITIVE_KEYS)).toEqual(new Set([
      'anthropicAdminApiKey', 'anthropicAnalyticsApiKey', 'anthropicAiApiKey',
      'otelEndpointSecret', 'archiveAccessKeyId', 'archiveSecretAccessKey',
      'smtpPassword', 'digestSlackWebhookUrl', 'ssoClientSecret', 'dxApiKey',
      'complianceAccessKey', 'githubToken',
      'alertsSlackWebhookUrl',
    ]));
  });

  it('every SENSITIVE_KEYS entry has a registry definition with a label', () => {
    for (const key of SENSITIVE_KEYS) {
      expect(SECRET_KEYS[key], `missing registry entry for ${key}`).toBeDefined();
      expect(SECRET_KEYS[key].label.length).toBeGreaterThan(0);
      expect(Array.isArray(SECRET_KEYS[key].associatedKeys)).toBe(true);
    }
  });

  it('compliance key resets all six sync bookmarks', () => {
    expect(new Set(SECRET_KEYS.complianceAccessKey.associatedKeys)).toEqual(new Set([
      'complianceChatCursor', 'complianceActivityCursorAsc',
      'complianceLastSyncAt', 'complianceLastSyncStats',
      'complianceActivityCursor', 'complianceLastCursor',
    ]));
  });

  it('analytics key resets its date cursor', () => {
    expect(SECRET_KEYS.anthropicAnalyticsApiKey.associatedKeys).toEqual(['analyticsLastDate']);
  });

  it('github key resets its last-sync bookmark', () => {
    expect(SECRET_KEYS.githubToken.associatedKeys).toEqual(['githubSyncLastRun']);
  });
});

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// SINGLE SOURCE for sensitive config keys. A key listed here is (1) masked by
// GET /api/config and (2) removable via DELETE /api/config/secret, which also
// deletes its associatedKeys (job-written cursors/stats) so a future key
// starts a correct first-run backfill. Registering here is MANDATORY for any
// new secret — test/config-secrets-registry.test.ts enforces coverage.
// NOTE: distinct from lib/config.ts's internal SENSITIVE_KEYS (legacy
// decrypt-on-read set) — do not conflate them.
import type { AppConfig } from '@/lib/config';

export interface SecretKeyDef {
  /** Human name used in confirm dialogs and audit detail. */
  label: string;
  /** Job-written state deleted alongside the key on removal. */
  associatedKeys: (keyof AppConfig)[];
}

export const SECRET_KEYS: Record<string, SecretKeyDef> = {
  anthropicAiApiKey: { label: 'Anthropic AI API key', associatedKeys: [] },
  anthropicAdminApiKey: { label: 'Admin API key', associatedKeys: [] },
  anthropicAnalyticsApiKey: {
    label: 'Analytics API key',
    associatedKeys: ['analyticsLastDate'],
  },
  complianceAccessKey: {
    label: 'Compliance Access Key',
    associatedKeys: [
      'complianceChatCursor',
      'complianceActivityCursorAsc',
      'complianceLastSyncAt',
      'complianceLastSyncStats',
      // Legacy orphans from the desc-cursor era — swept for cleanliness.
      'complianceActivityCursor',
      'complianceLastCursor',
    ],
  },
  otelEndpointSecret: { label: 'OTel endpoint secret', associatedKeys: [] },
  archiveAccessKeyId: { label: 'Archive access key ID', associatedKeys: [] },
  archiveSecretAccessKey: { label: 'Archive secret access key', associatedKeys: [] },
  smtpPassword: { label: 'SMTP password', associatedKeys: [] },
  digestSlackWebhookUrl: { label: 'Digest Slack webhook', associatedKeys: [] },
  alertsSlackWebhookUrl: { label: 'High-priority alerts Slack webhook', associatedKeys: [] },
  ssoClientSecret: { label: 'SSO client secret', associatedKeys: [] },
  dxApiKey: { label: 'DX API token', associatedKeys: [] },
  githubToken: { label: 'GitHub API token', associatedKeys: ['githubSyncLastRun'] },
};

export const SENSITIVE_KEYS = Object.keys(SECRET_KEYS) as (keyof AppConfig)[];

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type { ArchiveProvider, ArchiveProviderConfig } from '../provider';

export class GcsProvider implements ArchiveProvider {
  async upload(): Promise<void> {
    throw new Error('Google Cloud Storage support coming soon');
  }
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Google Cloud Storage support coming soon' };
  }
  getConfig(): ArchiveProviderConfig {
    return { provider: 'gcs' };
  }
}

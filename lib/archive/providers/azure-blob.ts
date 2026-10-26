// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type { ArchiveProvider, ArchiveProviderConfig } from '../provider';

export class AzureBlobProvider implements ArchiveProvider {
  async upload(): Promise<void> {
    throw new Error('Azure Blob Storage support coming soon');
  }
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Azure Blob Storage support coming soon' };
  }
  getConfig(): ArchiveProviderConfig {
    return { provider: 'azure-blob' };
  }
}

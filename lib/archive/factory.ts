// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type { ArchiveProvider, ArchiveProviderConfig, S3ProviderConfig } from './provider';

export async function createProvider(config: ArchiveProviderConfig): Promise<ArchiveProvider> {
  switch (config.provider) {
    case 's3': {
      const s3Config = config as S3ProviderConfig;
      if (!s3Config.bucket || !s3Config.region || !s3Config.accessKeyId || !s3Config.secretAccessKey) {
        throw new Error('S3 provider requires bucket, region, accessKeyId, and secretAccessKey');
      }
      const { S3Provider } = await import('./providers/s3');
      return new S3Provider(s3Config);
    }
    case 'azure-blob': {
      const { AzureBlobProvider } = await import('./providers/azure-blob');
      return new AzureBlobProvider();
    }
    case 'gcs': {
      const { GcsProvider } = await import('./providers/gcs');
      return new GcsProvider();
    }
    default:
      throw new Error(`Unknown archive provider: ${(config as { provider: string }).provider}`);
  }
}

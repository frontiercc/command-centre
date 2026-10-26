// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

export interface ArchiveProvider {
  upload(key: string, data: Buffer): Promise<void>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  getConfig(): ArchiveProviderConfig;
}

export interface S3ProviderConfig {
  provider: 's3';
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AzureBlobProviderConfig {
  provider: 'azure-blob';
}

export interface GcsProviderConfig {
  provider: 'gcs';
}

export type ArchiveProviderConfig = S3ProviderConfig | AzureBlobProviderConfig | GcsProviderConfig;

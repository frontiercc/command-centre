// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { ArchiveProvider, ArchiveProviderConfig, S3ProviderConfig } from '../provider';

export class S3Provider implements ArchiveProvider {
  private client: S3Client;
  private bucket: string;
  private providerConfig: S3ProviderConfig;

  constructor(config: S3ProviderConfig) {
    this.providerConfig = config;
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: 'application/gzip',
    }));
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true };
    } catch (err) {
      // The S3 library's text stays in the server log; the admin gets a fixed hint.
      console.error('[archive/s3] connection test failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      return { ok: false, error: 'Archive test failed: check the provider, bucket, region and credentials. Details are in the server log.' };
    }
  }

  getConfig(): ArchiveProviderConfig {
    return this.providerConfig;
  }
}

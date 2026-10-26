// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { createProvider } from '@/lib/archive/factory';
import { getConfigValue } from '@/lib/config';
import type { ArchiveProviderConfig, S3ProviderConfig } from '@/lib/archive/provider';
import { requireAdmin } from '@/lib/auth/admin-auth';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  try {
    const body = await request.json();

    const provider = body.provider || await getConfigValue('archiveProvider');
    if (!provider) {
      return NextResponse.json({ ok: false, error: 'No provider configured' });
    }

    let config: ArchiveProviderConfig;
    if (provider === 's3') {
      config = {
        provider: 's3',
        bucket: body.bucket || await getConfigValue('archiveBucket'),
        region: body.region || await getConfigValue('archiveRegion'),
        accessKeyId: body.accessKeyId || await getConfigValue('archiveAccessKeyId'),
        secretAccessKey: body.secretAccessKey || await getConfigValue('archiveSecretAccessKey'),
      } satisfies S3ProviderConfig;
    } else {
      config = { provider } as ArchiveProviderConfig;
    }

    const archiveProvider = await createProvider(config);
    const result = await archiveProvider.testConnection();
    return NextResponse.json(result);
  } catch (err) {
    logError('api/archive/test', err);
    return NextResponse.json({ ok: false, error: 'Archive test failed: check the provider, bucket, region and credentials. Details are in the server log.' });
  }
}

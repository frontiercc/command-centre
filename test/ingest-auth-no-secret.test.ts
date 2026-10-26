// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The developer bypass flag must never open ingest
// in production. With no ingest secret configured, production refuses every
// request whether or not CCC_DEV_BYPASS_AUTH is set; outside production the old
// accept-all behaviour (used by the test suite and local dev) is unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(async () => '') }));
vi.mock('@/lib/db/auth-events', () => ({ logAuthEvent: vi.fn(async () => {}) }));

const req = () => new NextRequest('http://localhost/api/otel/ingest', { method: 'POST' });

afterEach(() => vi.unstubAllEnvs());

describe('ingest auth with no secret configured', () => {
  it('production refuses, even with CCC_DEV_BYPASS_AUTH=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CCC_DEV_BYPASS_AUTH', 'true');
    vi.stubEnv('CCC_COLLECTOR_TOKEN', '');
    vi.stubEnv('OTEL_ENDPOINT_SECRET', '');
    const { authenticateIngest, legacyNoSecretAllowed } = await import('@/lib/auth/ingest-auth');
    expect(legacyNoSecretAllowed()).toBe(false);
    const r = await authenticateIngest(req());
    expect(r.authenticated).toBe(false);
    expect(r.httpStatus).toBe(401);
  });

  it('non-production still accepts (local dev and tests)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CCC_COLLECTOR_TOKEN', '');
    vi.stubEnv('OTEL_ENDPOINT_SECRET', '');
    const { authenticateIngest } = await import('@/lib/auth/ingest-auth');
    expect((await authenticateIngest(req())).authenticated).toBe(true);
  });
});

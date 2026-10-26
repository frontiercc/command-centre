// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Connect Claude box: the collector address and bearer token come from the
// display-only CCC_CLIENT_BEARER_TOKEN (never a credential the Hub accepts),
// and the copied settings carry them in the right places.
import { describe, it, expect } from 'vitest';
import { getCollectorConnection, normaliseCollectorAddress, DEFAULT_COLLECTOR_ADDRESS } from '@/lib/setup/collector';
import { claudeCodeSettings } from '@/lib/setup/claude-settings';

describe('getCollectorConnection', () => {
  it('still gives the address when the install does not pass the bearer token to the Hub', () => {
    expect(getCollectorConnection({})).toEqual({ address: DEFAULT_COLLECTOR_ADDRESS, token: null });
    expect(getCollectorConnection({ CCC_CLIENT_BEARER_TOKEN: '  ' }, 'https://saved.example.com'))
      .toEqual({ address: 'https://saved.example.com', token: null });
  });

  it('never reads the Hub credentials', () => {
    const env = { OTEL_ENDPOINT_SECRET: 'hub-secret', CCC_COLLECTOR_TOKEN: 'collector-token' };
    expect(getCollectorConnection(env).token).toBeNull();
  });

  it('defaults the address to the local collector', () => {
    expect(getCollectorConnection({ CCC_CLIENT_BEARER_TOKEN: 'abc' }))
      .toEqual({ address: DEFAULT_COLLECTOR_ADDRESS, token: 'abc' });
  });

  it('uses the configured address when one is set', () => {
    const env = { CCC_CLIENT_BEARER_TOKEN: 'abc', CCC_COLLECTOR_ADDRESS: 'https://otel.example.com' };
    expect(getCollectorConnection(env).address).toBe('https://otel.example.com');
  });

  it('prefers the address an admin saved, and falls back when it is blank', () => {
    const env = { CCC_CLIENT_BEARER_TOKEN: 'abc', CCC_COLLECTOR_ADDRESS: 'https://from-env.example.com' };
    expect(getCollectorConnection(env, 'https://saved.example.com').address).toBe('https://saved.example.com');
    expect(getCollectorConnection(env, '  ').address).toBe('https://from-env.example.com');
    expect(getCollectorConnection({ CCC_CLIENT_BEARER_TOKEN: 'abc' }, '').address).toBe(DEFAULT_COLLECTOR_ADDRESS);
  });
});

describe('normaliseCollectorAddress', () => {
  it('accepts http and https addresses and drops a trailing slash', () => {
    expect(normaliseCollectorAddress(' https://otel.example.com/ ')).toBe('https://otel.example.com');
    expect(normaliseCollectorAddress('http://10.0.0.5:4318')).toBe('http://10.0.0.5:4318');
  });

  it('allows blank, meaning use the default', () => {
    expect(normaliseCollectorAddress('   ')).toBe('');
  });

  it('refuses anything that is not an http or https address', () => {
    for (const bad of ['otel.example.com', 'ftp://otel.example.com', 'javascript:alert(1)', 'https://']) {
      expect(normaliseCollectorAddress(bad)).toBeNull();
    }
  });
});

describe('copied Claude settings', () => {
  const address = 'http://localhost:4318';
  const token = 'tok123';

  it('managed settings carry the address, the bearer header and delta temporality', () => {
    const env = JSON.parse(claudeCodeSettings(address, token)).env;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(address);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer tok123');
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('delta');
    expect(env.OTEL_SERVICE_NAME).toBe('claude-code');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });
});

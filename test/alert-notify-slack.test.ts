// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Alert } from '@/lib/db/queries';

const configStore: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
}));

const fetchMock = vi.fn();
let notifyAlertSlack: typeof import('@/lib/alerts/notify-slack').notifyAlertSlack;

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1', user_id: 'sam.taylor', alert_type: 'code_cost_spike', severity: 'high',
    title: 'Spend spike', explanation: 'explanation text', raw_evidence: null,
    status: 'open', generated_at: 1000, resolved_at: null, resolved_by: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  const mod = await import('@/lib/alerts/notify-slack');
  notifyAlertSlack = mod.notifyAlertSlack;
});

afterEach(() => vi.unstubAllGlobals());

function enable() {
  configStore['alertsSlackEnabled'] = 'true';
  configStore['alertsSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
}

describe('notifyAlertSlack', () => {
  it('posts to Slack for a high-severity alert when enabled', async () => {
    enable();
    await notifyAlertSlack(makeAlert({ severity: 'high' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts to Slack for a critical-severity alert when enabled', async () => {
    enable();
    await notifyAlertSlack(makeAlert({ severity: 'critical' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not post for a medium-severity alert', async () => {
    enable();
    await notifyAlertSlack(makeAlert({ severity: 'medium' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not post for a low-severity alert', async () => {
    enable();
    await notifyAlertSlack(makeAlert({ severity: 'low' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not post when alertsSlackEnabled is not true', async () => {
    configStore['alertsSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
    await notifyAlertSlack(makeAlert({ severity: 'critical' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not post when no webhook URL is configured', async () => {
    configStore['alertsSlackEnabled'] = 'true';
    await notifyAlertSlack(makeAlert({ severity: 'critical' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the webhook POST fails', async () => {
    enable();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    await expect(notifyAlertSlack(makeAlert({ severity: 'critical' }))).resolves.toBeUndefined();
  });

  it('never throws on a network error', async () => {
    enable();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(notifyAlertSlack(makeAlert({ severity: 'critical' }))).resolves.toBeUndefined();
  });

  it('never throws when getConfigValue fails', async () => {
    enable();
    const { getConfigValue } = await import('@/lib/config');
    vi.mocked(getConfigValue).mockRejectedValueOnce(new Error('DB connection failed'));
    await expect(notifyAlertSlack(makeAlert({ severity: 'critical' }))).resolves.toBeUndefined();
  });
});

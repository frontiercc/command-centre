// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DigestData } from '@/lib/digest/build';
import type { DeliveryResult } from '@/lib/digest/deliver';
import { weekStart } from '@/lib/pulse/period';

// ── Mocks ──
// Config values are read from an in-memory map so each test can set only
// what it needs; unset keys resolve to '' (mirrors getConfigValue's contract).
const configStore: Record<string, string> = {};
const setConfigValueMock = vi.fn((key: string, value: string) => {
  configStore[key] = value;
});

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
  setConfigValue: (...args: [string, string]) => setConfigValueMock(...args),
}));

const buildDigestMock = vi.fn();
vi.mock('@/lib/digest/build', () => ({
  buildDigest: (...args: unknown[]) => buildDigestMock(...args),
}));

const sendDigestMock = vi.fn();
vi.mock('@/lib/digest/deliver', () => ({
  sendDigest: (...args: unknown[]) => sendDigestMock(...args),
}));

let shouldSendDigest: typeof import('../lib/digest/schedule').shouldSendDigest;
let runDigestJob: typeof import('../lib/digest/schedule').runDigestJob;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  setConfigValueMock.mockClear();
  buildDigestMock.mockReset();
  sendDigestMock.mockReset();

  const mod = await import('../lib/digest/schedule');
  shouldSendDigest = mod.shouldSendDigest;
  runDigestJob = mod.runDigestJob;
});

function enable() {
  configStore['digestEnabled'] = 'true';
}

function configureSlack() {
  configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
}

function configureEmail() {
  configStore['smtpHost'] = 'smtp.example.com';
  configStore['smtpUser'] = 'user@example.com';
  configStore['smtpPassword'] = 'secret';
  configStore['smtpFromAddress'] = 'noreply@example.com';
  configStore['digestRecipients'] = 'exec@example.com';
}

// Monday 2026-06-22 08:00:00 UTC
const MONDAY_0800 = Date.UTC(2026, 5, 22, 8, 0, 0) / 1000;
// Monday 2026-06-22 06:59:00 UTC
const MONDAY_0659 = Date.UTC(2026, 5, 22, 6, 59, 0) / 1000;
// Tuesday 2026-06-23 08:00:00 UTC
const TUESDAY_0800 = Date.UTC(2026, 5, 23, 8, 0, 0) / 1000;

describe('shouldSendDigest', () => {
  it('returns true on Monday at/after the send hour when enabled and Slack configured', async () => {
    enable();
    configureSlack();

    expect(await shouldSendDigest(MONDAY_0800)).toBe(true);
  });

  it('returns true on Monday at/after the send hour when enabled and email configured', async () => {
    enable();
    configureEmail();

    expect(await shouldSendDigest(MONDAY_0800)).toBe(true);
  });

  it('returns false on Tuesday', async () => {
    enable();
    configureSlack();

    expect(await shouldSendDigest(TUESDAY_0800)).toBe(false);
  });

  it('returns false on Monday before the default send hour (07:00 UTC)', async () => {
    enable();
    configureSlack();

    expect(await shouldSendDigest(MONDAY_0659)).toBe(false);
  });

  it('returns false when this week has already been sent', async () => {
    enable();
    configureSlack();
    configStore['digestLastSentWeek'] = String(weekStart(MONDAY_0800));

    expect(await shouldSendDigest(MONDAY_0800)).toBe(false);
  });

  it('returns false when digest is disabled', async () => {
    configureSlack();
    // digestEnabled left unset -> not 'true'

    expect(await shouldSendDigest(MONDAY_0800)).toBe(false);
  });

  it('returns false when enabled but no channel is configured', async () => {
    enable();
    // Neither Slack webhook nor (SMTP + recipients) configured.

    expect(await shouldSendDigest(MONDAY_0800)).toBe(false);
  });

  it('returns false when SMTP is configured but there are no recipients', async () => {
    enable();
    configStore['smtpHost'] = 'smtp.example.com';
    configStore['smtpUser'] = 'user@example.com';
    configStore['smtpPassword'] = 'secret';
    configStore['smtpFromAddress'] = 'noreply@example.com';
    // digestRecipients left unset

    expect(await shouldSendDigest(MONDAY_0800)).toBe(false);
  });

  it('respects a custom digestSendHourUtc', async () => {
    enable();
    configureSlack();
    configStore['digestSendHourUtc'] = '9';

    // 08:00 UTC is before the custom 09:00 send hour.
    expect(await shouldSendDigest(MONDAY_0800)).toBe(false);

    const monday0900 = Date.UTC(2026, 5, 22, 9, 0, 0) / 1000;
    expect(await shouldSendDigest(monday0900)).toBe(true);
  });

  it('falls back to the default send hour (7) when digestSendHourUtc is invalid', async () => {
    enable();
    configureSlack();
    configStore['digestSendHourUtc'] = 'not-a-number';

    const monday0700 = Date.UTC(2026, 5, 22, 7, 0, 0) / 1000;
    expect(await shouldSendDigest(monday0700)).toBe(true);
  });
});

describe('runDigestJob', () => {
  function fullData(): DigestData {
    return {
      weekStart: weekStart(MONDAY_0800) - 7 * 86400,
      weekEnd: weekStart(MONDAY_0800),
      code: null,
      cowork: null,
      anomaly: null,
      briefingExcerpt: null,
      useCases: null,
      coaching: null,
    };
  }

  it('sets digestLastSentWeek when at least one channel reports sent', async () => {
    enable();
    configureSlack();
    buildDigestMock.mockReturnValue(fullData());
    sendDigestMock.mockResolvedValue({ email: 'skipped', slack: 'sent', errors: [] } as DeliveryResult);

    await runDigestJob(MONDAY_0800);

    expect(sendDigestMock).toHaveBeenCalledTimes(1);
    expect(setConfigValueMock).toHaveBeenCalledWith('digestLastSentWeek', String(weekStart(MONDAY_0800)));
  });

  it('does not set digestLastSentWeek when all configured channels fail', async () => {
    enable();
    configureSlack();
    buildDigestMock.mockReturnValue(fullData());
    sendDigestMock.mockResolvedValue({ email: 'skipped', slack: 'failed', errors: ['slack: boom'] } as DeliveryResult);

    await runDigestJob(MONDAY_0800);

    expect(sendDigestMock).toHaveBeenCalledTimes(1);
    expect(setConfigValueMock).not.toHaveBeenCalledWith('digestLastSentWeek', expect.anything());
  });

  it('never calls sendDigest when buildDigest returns null', async () => {
    enable();
    configureSlack();
    buildDigestMock.mockReturnValue(null);

    await runDigestJob(MONDAY_0800);

    expect(sendDigestMock).not.toHaveBeenCalled();
    expect(setConfigValueMock).not.toHaveBeenCalledWith('digestLastSentWeek', expect.anything());
  });

  it('does nothing when shouldSendDigest is false', async () => {
    // disabled
    configureSlack();

    await runDigestJob(MONDAY_0800);

    expect(buildDigestMock).not.toHaveBeenCalled();
    expect(sendDigestMock).not.toHaveBeenCalled();
  });

  it('uses the default hub URL when digestHubUrl is unset', async () => {
    enable();
    configureSlack();
    buildDigestMock.mockReturnValue(fullData());
    sendDigestMock.mockResolvedValue({ email: 'skipped', slack: 'sent', errors: [] } as DeliveryResult);

    await runDigestJob(MONDAY_0800);

    expect(sendDigestMock).toHaveBeenCalledWith(expect.anything(), 'http://localhost:3001');
  });

  it('uses digestHubUrl when configured', async () => {
    enable();
    configureSlack();
    configStore['digestHubUrl'] = 'https://ccc.example.com';
    buildDigestMock.mockReturnValue(fullData());
    sendDigestMock.mockResolvedValue({ email: 'skipped', slack: 'sent', errors: [] } as DeliveryResult);

    await runDigestJob(MONDAY_0800);

    expect(sendDigestMock).toHaveBeenCalledWith(expect.anything(), 'https://ccc.example.com');
  });
});

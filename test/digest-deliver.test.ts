// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DigestData } from '@/lib/digest/build';

const DAY = 86400;
const WEEK = 7 * DAY;
const WEEK_START = Date.UTC(2026, 5, 22) / 1000; // 2026-06-22 (Mon)
const WEEK_END = WEEK_START + WEEK;
const HUB_URL = 'https://ccc.example.com';

function fullData(overrides: Partial<DigestData> = {}): DigestData {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    code: {
      spendUsd: 1234.5,
      spendDeltaPct: 0.12,
      spendIsPartlyEstimated: false,
      unpricedModelCount: 0,
      commits: 42,
      prs: 7,
      engagedHours: 88.5,
      activeUsers: 12,
    },
    cowork: null,
    anomaly: null,
    briefingExcerpt: null,
    useCases: null,
    coaching: null,
    ...overrides,
  };
}

// ── Mocks ──
// Config values are read from an in-memory map so each test can set only
// what it needs; unset keys resolve to '' (mirrors getConfigValue's contract).
const configStore: Record<string, string> = {};

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
}));

const sendMailMock = vi.fn();
const createTransportMock = vi.fn((..._args: unknown[]) => ({ sendMail: sendMailMock }));

vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransportMock(...args) },
}));

const fetchMock = vi.fn();

// `renderDigestSlack` is wrapped in a mock that defaults to the real
// implementation (via vi.importActual) so every existing test still renders
// real Slack payloads; a single test below overrides it to throw, to prove
// `sendDigest` captures a renderer exception as `slack: 'failed'` instead of
// letting it propagate out of the Promise.all.
const renderDigestSlackMock = vi.fn();

vi.mock('@/lib/digest/render', async () => {
  const actual = await vi.importActual<typeof import('../lib/digest/render')>('../lib/digest/render');
  renderDigestSlackMock.mockImplementation(actual.renderDigestSlack);
  return {
    ...actual,
    renderDigestSlack: (...args: Parameters<typeof actual.renderDigestSlack>) => renderDigestSlackMock(...args),
  };
});

let sendDigest: typeof import('../lib/digest/deliver').sendDigest;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(configStore)) delete configStore[key];
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  createTransportMock.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);

  const mod = await import('../lib/digest/deliver');
  sendDigest = mod.sendDigest;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configureSmtp() {
  configStore['smtpHost'] = 'smtp.example.com';
  configStore['smtpPort'] = '587';
  configStore['smtpUser'] = 'user@example.com';
  configStore['smtpPassword'] = 'secret';
  configStore['smtpFromAddress'] = 'noreply@example.com';
  configStore['smtpFromName'] = 'Frontier Command Centre';
}

function configureRecipients() {
  configStore['digestRecipients'] = 'a@example.com, b@example.com , ,invalid-email';
}

function configureSlack() {
  configStore['digestSlackWebhookUrl'] = 'https://hooks.slack.com/services/T000/B000/XXXX';
}

describe('sendDigest', () => {
  it('sends both email and Slack when both are configured', async () => {
    configureSmtp();
    configureRecipients();
    configureSlack();

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('sent');
    expect(result.slack).toBe('sent');
    expect(result.errors).toEqual([]);

    // Email: recipient list is the valid, trimmed, non-empty addresses only.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.to).toBe('a@example.com, b@example.com');
    expect(mailArgs.subject).toContain('Your AI week');
    expect(typeof mailArgs.html).toBe('string');
    expect(mailArgs.html).toContain('Frontier Command Centre');

    // Slack: webhook URL + JSON body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T000/B000/XXXX');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.blocks)).toBe(true);
  });

  it('skips email when only Slack is configured', async () => {
    configureSlack();

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('skipped');
    expect(result.slack).toBe('sent');
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips Slack when only email is configured', async () => {
    configureSmtp();
    configureRecipients();

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('sent');
    expect(result.slack).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks email failed and captures the error when SMTP throws, but Slack still sends', async () => {
    configureSmtp();
    configureRecipients();
    configureSlack();
    sendMailMock.mockRejectedValue(new Error('connection refused'));

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('failed');
    expect(result.slack).toBe('sent');
    expect(result.errors.some(e => e.includes('connection refused'))).toBe(true);
  });

  it('marks Slack failed and captures the error when the webhook POST fails, but email still sends', async () => {
    configureSmtp();
    configureRecipients();
    configureSlack();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('sent');
    expect(result.slack).toBe('failed');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-https webhook URL as failed validation without calling fetch', async () => {
    configureSmtp();
    configureRecipients();
    configStore['digestSlackWebhookUrl'] = 'http://hooks.slack.com/services/T000/B000/XXXX';

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.slack).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('skips both channels when neither is configured', async () => {
    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('skipped');
    expect(result.slack).toBe('skipped');
    expect(result.errors).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips email when recipients config is present but empty after trimming/validation', async () => {
    configureSmtp();
    configStore['digestRecipients'] = ' , ,invalid-email';

    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.email).toBe('skipped');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('marks Slack failed and resolves (never throws/rejects) when the renderer itself throws', async () => {
    configureSlack();
    renderDigestSlackMock.mockImplementation(() => {
      throw new Error('render boom');
    });

    // The regression this guards: deliverSlack used to call renderDigestSlack
    // OUTSIDE its try block, so a renderer exception propagated through
    // Promise.all and rejected sendDigest itself — contradicting sendDigest's
    // own "never throws" doc comment. Asserting on the resolved value (not
    // wrapping in expect(...).rejects) is itself part of the proof: if the
    // regression were reintroduced, this `await` would throw and the test
    // would fail with an unhandled rejection, not a false 'sent'/'failed'.
    const result = await sendDigest(fullData(), HUB_URL);

    expect(result.slack).toBe('failed');
    expect(result.errors.some(e => e.includes('render boom'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

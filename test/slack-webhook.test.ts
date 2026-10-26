// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postToSlackWebhook, isValidWebhookUrl } from '@/lib/slack/webhook';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isValidWebhookUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidWebhookUrl('https://hooks.slack.com/services/x')).toBe(true);
  });

  it('rejects http and malformed URLs', () => {
    expect(isValidWebhookUrl('http://hooks.slack.com/services/x')).toBe(false);
    expect(isValidWebhookUrl('not-a-url')).toBe(false);
  });
});

describe('postToSlackWebhook', () => {
  it('posts the payload as JSON and resolves ok on 2xx', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const result = await postToSlackWebhook('https://hooks.slack.com/services/x', { blocks: [] });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/x');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ blocks: [] });
  });

  it('resolves ok:false without throwing on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    const result = await postToSlackWebhook('https://hooks.slack.com/services/x', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('resolves ok:false without throwing on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await postToSlackWebhook('https://hooks.slack.com/services/x', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('rejects a non-https URL without calling fetch', async () => {
    const result = await postToSlackWebhook('http://hooks.slack.com/services/x', {});
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out and resolves ok:false when the request hangs', async () => {
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const result = await postToSlackWebhook('https://hooks.slack.com/services/x', {}, { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });
});

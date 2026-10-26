// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic Slack incoming-webhook POST — shared by the Weekly Digest
 * (lib/digest/deliver.ts) and the high-priority alerts notifier
 * (lib/alerts/notify-slack.ts). Never throws: every failure mode
 * (invalid URL, non-2xx response, network error, timeout) resolves to
 * {ok:false, error} instead.
 */
export interface SlackPostResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function isValidWebhookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function postToSlackWebhook(
  url: string,
  payload: object,
  opts: { timeoutMs?: number } = {}
): Promise<SlackPostResult> {
  if (!isValidWebhookUrl(url)) {
    return { ok: false, error: 'webhook URL must be https' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `webhook responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'webhook request timed out' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

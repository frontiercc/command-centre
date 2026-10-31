// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OpenAI Compliance Logs Platform client: lists and downloads the export files
// that carry ChatGPT and Codex activity. Endpoints and shapes per OpenAI's Admin
// API reference (v2.5.40). HTTP only: no DB access, no config reads.
//
// The base URL can be pointed at the localhost stand-in (scripts/openai-mock)
// with CCC_OPENAI_API_BASE_URL; everything else uses OpenAI's own address.
import { withBackoff } from '@/lib/ingestion/scheduler';
import { retryAfterSeconds } from '@/lib/compliance/client';

export const DEFAULT_OPENAI_API_BASE = 'https://api.chatgpt.com/v1';

export function openAiApiBase(): string {
  return (process.env.CCC_OPENAI_API_BASE_URL || DEFAULT_OPENAI_API_BASE).replace(/\/+$/, '');
}

export class OpenAiApiError extends Error {
  constructor(public status: number, public body: string) {
    // withBackoff retries by reading the status out of the message, so the
    // number stays in it; the body does not, so a 401 body mentioning "429"
    // is never retried.
    super(`OpenAI API error ${status}`);
    this.name = 'OpenAiApiError';
  }
}

/** Where a log type is listed: ChatGPT and Codex logs by workspace, COSTS by organisation. */
export type LogScope = { kind: 'workspace' | 'organization'; id: string };

export type OpenAiEventType = 'CONVERSATION_MESSAGE' | 'CODEX_LOG' | 'CODEX_TURN' | 'COSTS';

export interface LogFileMetadata {
  id: string;
  event_type: string;
  end_time: string;
  file_name: string;
  file_size: number;
  file_sha256: string;
}

export interface LogFileList {
  data: LogFileMetadata[];
  has_more: boolean;
  last_end_time?: string | null;
}

function scopePath(scope: LogScope): string {
  const segment = scope.kind === 'workspace' ? 'workspaces' : 'organizations';
  return `/compliance/${segment}/${encodeURIComponent(scope.id)}`;
}

async function openAiFetch(apiKey: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  if (response.status === 429) {
    // Honour Retry-After before withBackoff's own retry.
    await new Promise(r => setTimeout(r, retryAfterSeconds(response.headers.get('retry-after')) * 1000));
  }
  return response;
}

async function failWith(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  throw new OpenAiApiError(response.status, text.slice(0, 500));
}

/** Files whose end_time is strictly after `after`, oldest first, at most `limit` (1-100). */
export function listLogFiles(
  apiKey: string,
  scope: LogScope,
  eventType: OpenAiEventType,
  after: string,
  limit = 100,
): Promise<LogFileList> {
  return withBackoff(async () => {
    const url = new URL(`${openAiApiBase()}${scopePath(scope)}/logs`);
    url.searchParams.set('event_type', eventType);
    url.searchParams.set('after', after);
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
    const response = await openAiFetch(apiKey, url.toString());
    if (!response.ok) return failWith(response);
    return response.json() as Promise<LogFileList>;
  });
}

/**
 * Downloads one file as text. OpenAI answers with a 307 to a short-lived signed
 * link, which is fetched WITHOUT the admin key: the key must never go to the
 * storage host. Only https links are followed, unless the API itself is plain
 * http (the localhost stand-in).
 */
export function downloadLogFile(apiKey: string, scope: LogScope, fileId: string): Promise<string> {
  return withBackoff(async () => {
    const url = `${openAiApiBase()}${scopePath(scope)}/logs/${encodeURIComponent(fileId)}`;
    const response = await openAiFetch(apiKey, url, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new OpenAiApiError(502, 'redirect without a location');
      const target = new URL(location, url);
      const allowHttp = openAiApiBase().startsWith('http://');
      if (target.protocol !== 'https:' && !(allowHttp && target.protocol === 'http:')) {
        throw new OpenAiApiError(502, 'download link is not https');
      }
      const file = await fetch(target.toString());
      if (!file.ok) return failWith(file);
      return file.text();
    }
    if (!response.ok) return failWith(response);
    return response.text();
  });
}

/** Latest event time OpenAI holds for each type (null when it holds none). */
export function getMaxEventTime(
  apiKey: string,
  scope: LogScope,
  eventTypes: OpenAiEventType[],
): Promise<Record<string, string | null>> {
  return withBackoff(async () => {
    const url = new URL(`${openAiApiBase()}${scopePath(scope)}/max_event_time`);
    for (const t of eventTypes) url.searchParams.append('event_type', t);
    const response = await openAiFetch(apiKey, url.toString());
    if (!response.ok) return failWith(response);
    const body = (await response.json()) as { max_event_time?: Record<string, string | null> };
    return body.max_event_time ?? {};
  });
}

/** Parses a JSONL file; a line that is not JSON is skipped and counted. */
export function parseJsonl(text: string): { records: unknown[]; badLines: number } {
  const records: unknown[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

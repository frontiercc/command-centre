// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Anthropic Compliance API client. Endpoints per the
// published docs; LIVE-VERIFIED against an Enterprise tenant
// (chats + messages + activities all pulling clean). HTTP only: no DB access, no config reads.
import { withBackoff } from '@/lib/ingestion/scheduler';

const BASE = 'https://api.anthropic.com/v1/compliance';

export class ComplianceApiError extends Error {
  constructor(public status: number, public body: string) {
    // withBackoff retries by sniffing the status code out of the message —
    // keep the number in the string. Only the status, not the body, to avoid
    // false retries when a 401/403/404 body happens to contain "429" or "5xx".
    super(`Compliance API error ${status}`);
    this.name = 'ComplianceApiError';
  }
}

export interface CompliancePage<T> { data: T[]; has_more: boolean; first_id: string | null; last_id: string | null }
export interface ComplianceChatSummary {
  id: string; name: string | null; created_at: string; updated_at: string;
  deleted_at: string | null; model: string | null; project_id: string | null;
  organization_uuid: string | null;
  user: { id: string; email_address: string };
}
export interface ComplianceTextBlock { type: 'text'; text?: string }
export interface ComplianceToolUseBlock {
  type: 'tool_use'; name?: string;
  integration_name?: string | null; mcp_server_url?: string | null;
}
export interface ComplianceChatMessage {
  id: string; role: 'user' | 'assistant'; created_at: string;
  content: Array<ComplianceTextBlock | ComplianceToolUseBlock | { type: string }>;
  files?: Array<{ id: string; filename: string; mime_type: string }> | null;
  generated_files?: Array<{ id: string; filename: string; mime_type: string }> | null;
  artifacts?: Array<{ id: string; version_id: string; title: string; artifact_type: string }> | null;
}
export interface ComplianceChatMessagesPage {
  chat_messages: ComplianceChatMessage[];
  has_more: boolean; first_id: string | null; last_id: string | null;
}
export interface ComplianceActivity {
  id: string; created_at: string; type: string;
  actor?: { type: string; email_address?: string; user_id?: string; ip_address?: string; user_agent?: string };
  [key: string]: unknown;
}

/**
 * Seconds to wait before retrying a 429, from the `retry-after` header.
 *
 * Honoured IN FULL up to a bound, not capped at 30s as it once was — the
 * docs tell you to honour the value, and a 60s instruction served under a
 * 30s cap produced a guaranteed second 429. The bound exists only so a
 * malformed or hostile value cannot stall a scheduler cycle; 60s is the
 * documented rate window, so nothing legitimate exceeds it.
 */
export const MAX_RETRY_AFTER_S = 60;

export function retryAfterSeconds(header: string | null): number {
  const parsed = Number.parseInt(header || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_RETRY_AFTER_S);
}

async function complianceGet<T>(apiKey: string, path: string, params: Record<string, string>): Promise<T> {
  return withBackoff(async () => {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!response.ok) {
      if (response.status === 429) {
        // Honour Retry-After before withBackoff's own retry kicks in.
        const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      }
      const text = await response.text();
      throw new ComplianceApiError(response.status, text.slice(0, 500));
    }
    return response.json() as Promise<T>;
  });
}

export function listChats(apiKey: string, opts: { afterId?: string; updatedAtGte?: string; limit?: number }): Promise<CompliancePage<ComplianceChatSummary>> {
  const params: Record<string, string> = { order_by: 'updated_at', limit: String(opts.limit ?? 100) };
  if (opts.afterId) params.after_id = opts.afterId;
  else if (opts.updatedAtGte) params['updated_at.gte'] = opts.updatedAtGte;
  return complianceGet(apiKey, '/apps/chats', params);
}

export function getChatMessages(apiKey: string, chatId: string, opts: { afterId?: string; limit?: number; createdAtGte?: string }): Promise<ComplianceChatMessagesPage> {
  const params: Record<string, string> = { limit: String(opts.limit ?? 100), order: 'asc' };
  if (opts.afterId) params.after_id = opts.afterId;
  // Retention floor applied server-side: syncChat discards anything older
  // than this anyway, so without the bound we page through history only to
  // throw it away — one request per 100 messages, every run, per chat.
  if (opts.createdAtGte) params['created_at.gte'] = opts.createdAtGte;
  return complianceGet(apiKey, `/apps/chats/${encodeURIComponent(chatId)}/messages`, params);
}

export function listActivities(apiKey: string, opts: { afterId?: string; gteIso?: string; order?: 'asc' | 'desc'; limit?: number }): Promise<CompliancePage<ComplianceActivity>> {
  const params: Record<string, string> = { order: opts.order ?? 'asc', limit: String(opts.limit ?? 100) };
  if (opts.afterId) params.after_id = opts.afterId;
  else if (opts.gteIso) params['created_at.gte'] = opts.gteIso;
  return complianceGet(apiKey, '/activities', params);
}

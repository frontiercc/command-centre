// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * A stable key per OTel log record, and the "already processed" check that
 * makes every receiver write idempotent.
 *
 * The collector re-delivers a batch it did not get a 2xx for. Rows used to get
 * random ids and counters were `+1` updates, so a re-delivered batch was stored
 * twice — which is why the hub could not safely ask for retries. Each record
 * now claims its key inside its own transaction; a key already claimed means
 * the record was stored before, and it is skipped whole.
 *
 * The key, most specific first (Anthropic's Claude Code monitoring docs):
 *   api_request / api_error  → request_id, else client_request_id
 *   tool_result / tool_decision → tool_use_id
 *   anything else            → sha256 of the whole record (service, session,
 *                              every attribute, timeUnixNano). A re-delivered
 *                              record is byte-identical; two genuinely
 *                              different events always differ somewhere.
 * event.sequence is never the key on its own: it restarts per process and can
 * repeat within a resumed session.
 */
import { createHash } from 'crypto';
import { schema } from '@/lib/db/schema';

export interface KeyAttr { key: string; value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean } }

function attrValue(attrs: KeyAttr[], key: string): string | undefined {
  const v = attrs.find(a => a.key === key)?.value;
  if (!v) return undefined;
  const s = v.stringValue ?? (v.intValue !== undefined ? String(v.intValue) : undefined);
  return s === '' ? undefined : s;
}

export function otelEventKey(p: {
  service: string;
  eventName: string;
  sessionId: string;
  attrs: KeyAttr[];
  timeUnixNano?: string;
}): string {
  const ev = p.eventName.replace(/^claude_code\./, '');
  if (ev === 'api_request' || ev === 'api_error') {
    const id = attrValue(p.attrs, 'request_id') ?? attrValue(p.attrs, 'client_request_id');
    if (id) return `${ev}:${id}`;
  }
  if (ev === 'tool_result' || ev === 'tool_decision') {
    const id = attrValue(p.attrs, 'tool_use_id');
    if (id) return `${ev}:${id}`;
  }
  const canonical = JSON.stringify([
    p.service, p.sessionId, ev, p.timeUnixNano ?? '',
    [...p.attrs].map(a => [a.key, a.value ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
  return `h:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Claim a record's key inside its own transaction. Returns false when the key
 * was already claimed (the record is a re-delivery and must be skipped). The
 * claim commits or rolls back with the record's own writes, so a record that
 * fails can be re-delivered cleanly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function claimOtelEvent(tx: any, eventKey: string, nowS: number): Promise<boolean> {
  const rows = await tx
    .insert(schema.otelIngestedEvents)
    .values({ event_key: eventKey, received_at: nowS })
    .onConflictDoNothing()
    .returning({ event_key: schema.otelIngestedEvents.event_key });
  return rows.length > 0;
}

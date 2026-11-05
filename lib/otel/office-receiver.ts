// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTLP traces ingest for Claude in Excel, Word, PowerPoint and Outlook (Office agents).
//
// The Office add-in exports trace spans (service.name 'office-agent') from the
// user's browser: one agent.query span per prompt, an agent.stream span per
// model call and an agent.tool_execution span per tool call, all sharing the
// prompt's trace id. Format confirmed from a live capture on a Team plan
// (2026-11-05) against the published span reference
// (claude.com/docs/office-agents/opentelemetry.md).
//
// Rows are stored beside Cowork in cowork_messages (surface 'cowork', source
// 'otel') with `product` set to the app, so Work Pulse, the classifier, use
// cases and the Audit Log read them unchanged:
//   agent.query          → cowork_user_message (the prompt text)
//   agent.stream         → cowork_api_request (model + tokens), or cowork_api_error
//   agent.tool_execution → cowork_tool_metadata (tool name, success, duration)
//   anything else        → skipped
//
// Never stored: tool.input and tool.output (they carry document content), the
// document's full address (only its file name, and only on a tool call that
// changed the document), and cost. Office sends no cost, and estimated Office
// spend must never be added into Cowork's reported spend, so cost_usd stays
// NULL and the tokens are priced where Office spend is shown.
import { v4 as uuidv4 } from 'uuid';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { textToJsonValue } from '@/lib/db/json';
import { detectPiiWithMatches, redactPii, type PiiMatch } from '@/lib/pii/detect';
import { detectIntent } from '@/lib/intent/detect';
import { getCustomCategories } from '@/lib/intent/custom';
import { createIntentAlerts } from '@/lib/alerts/intent-alerts';
import { createPiiAlertsWithDedup } from '@/lib/alerts/pii-alerts';
import { recordPiiAlertFailure } from '@/lib/alerts/pii-alert-failure';
import { CONTENT_PREVIEW_CHARS, CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';
import { resolveOtelUser } from '@/lib/otel/resolve-user';
import { recordIngestFailure } from '@/lib/otel/ingest-failure';
import { otelEventKey, claimOtelEvent } from '@/lib/otel/event-key';
import { displayNameFromEmail, type ProcessResult } from '@/lib/otel/cowork-receiver';

/** service.name the Office add-in reports. */
export const OFFICE_SERVICE_NAME = 'office-agent';

interface OtlpAttr {
  key: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttr[];
}

interface OtlpTracesPayload {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttr[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

/** agent.surface → the app it means. */
const PRODUCT_BY_SURFACE: Record<string, string> = {
  sheet: 'excel',
  doc: 'word',
  slide: 'powerpoint',
  mail: 'outlook',
};

/** The Office app a span came from, or null for a surface not yet known. */
export function officeProduct(surface: string | undefined): string | null {
  if (!surface) return null;
  return PRODUCT_BY_SURFACE[surface.trim().toLowerCase()] ?? null;
}

/**
 * Whether a tool call changed the document. PowerPoint and Excel mark changes
 * `tool.read_write = write`; Word proposes its edits through
 * `propose_doc_edits`, which the add-in marks as a read (seen in the capture).
 */
export function changedDocument(toolName: string, readWrite: string | undefined): boolean {
  return readWrite === 'write' || toolName === 'propose_doc_edits';
}

const MAX_NAME = 200;

/**
 * The document's file name from its address: the last path part, decoded,
 * with no folders, query or fragment, scrubbed of personal data. Null when
 * there is no usable name.
 */
export function documentFileName(url: string | undefined): string | null {
  if (!url) return null;
  let path = url.trim();
  try { path = new URL(path).pathname; } catch { path = path.split(/[?#]/)[0]; }
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  if (!last) return null;
  let name = last;
  try { name = decodeURIComponent(last); } catch { /* keep the raw part */ }
  name = name.trim();
  if (!name) return null;
  if (name.length > MAX_NAME) name = `${name.slice(0, MAX_NAME - 1)}…`;
  return redactPii(name);
}

function getAttr(attrs: OtlpAttr[], key: string): string | undefined {
  const v = attrs.find(a => a.key === key)?.value;
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return undefined;
}

function getNumber(attrs: OtlpAttr[], key: string): number | null {
  const s = getAttr(attrs, key);
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toSeconds(nano: string | undefined): number {
  return nano ? Math.floor(Number(nano) / 1_000_000_000) : Math.floor(Date.now() / 1000);
}

function durationMs(span: OtlpSpan): number | null {
  if (!span.startTimeUnixNano || !span.endTimeUnixNano) return null;
  const ms = Math.round((Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1_000_000);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

type Pending = { pii: { matches: PiiMatch[]; prompt: string; messageId: string } | null };

/**
 * Process an OTLP traces payload whose resources are all `office-agent`
 * (the ingest route splits by service.name before calling this).
 */
export async function processOfficeSpans(payload: unknown): Promise<ProcessResult> {
  const result: ProcessResult = { logsInserted: 0, skipped: 0, usersCreated: 0, sessionsCreated: 0, alertsFired: 0, errors: [] };
  const p = payload as OtlpTracesPayload;
  if (!p?.resourceSpans?.length) {
    result.errors.push('No resourceSpans in payload');
    return result;
  }

  const client = await getTypedClient();
  const customCategories = await getCustomCategories();
  const nowS = Math.floor(Date.now() / 1000);

  // Excluded emails, read once per payload.
  let excluded: string[] = [];
  const excludedRows = await client
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, 'otel_excluded_emails'))
    .limit(1);
  if (excludedRows[0]?.value) {
    try { excluded = (JSON.parse(excludedRows[0].value) as string[]).map(e => e.trim().toLowerCase()); } catch { /* malformed config: ignore */ }
  }

  // One resolution per person per payload.
  const userIds = new Map<string, string | null>();
  async function resolveUser(email: string, attrs: OtlpAttr[], eventCount: number): Promise<string | null> {
    const key = email.toLowerCase();
    if (userIds.has(key)) return userIds.get(key)!;
    try {
      const resolved = await resolveOtelUser(client, {
        email,
        installationId: null,
        displayName: displayNameFromEmail(email),
        department: null,
        accountUuid: getAttr(attrs, 'user.account_uuid') ?? null,
        surface: 'cowork',
        nowS,
        eventCount,
      });
      if (resolved.created) result.usersCreated++;
      if (resolved.existing) {
        await client.update(schema.users).set({ last_seen_at: nowS }).where(eq(schema.users.id, resolved.userId));
        await client
          .update(schema.adminUsers)
          .set({ linked_cowork_user_id: resolved.userId })
          .where(and(eq(schema.adminUsers.email, key), isNull(schema.adminUsers.linked_cowork_user_id)));
        // Mirror admin_users.department so Pulse groups the person, as the Cowork receiver does.
        await client
          .update(schema.users)
          .set({
            department: sql`COALESCE(${schema.users.department}, (SELECT department FROM admin_users WHERE email = ${key} AND department IS NOT NULL LIMIT 1))`,
          })
          .where(eq(schema.users.id, resolved.userId));
      }
      userIds.set(key, resolved.userId);
      return resolved.userId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Identity resolution failed, spans skipped: ${message}`);
      await recordIngestFailure('otel-ingest-identity', message, { surface: 'office', records: eventCount });
      userIds.set(key, null);
      return null;
    }
  }

  // Flatten, then handle each prompt's spans together (query last), so a
  // prompt that changed its document can name it on the tool rows.
  const spans: OtlpSpan[] = [];
  for (const rs of p.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) spans.push(s);
  }
  const order = (s: OtlpSpan) => (s.name === 'agent.query' ? 1 : 0);
  spans.sort((a, b) => order(a) - order(b));

  for (const span of spans) {
    const attrs = span.attributes ?? [];
    const name = span.name ?? '';
    if (name !== 'agent.query' && name !== 'agent.stream' && name !== 'agent.tool_execution') {
      result.skipped++;
      continue;
    }

    const email = getAttr(attrs, 'user.email');
    if (!email) {
      result.errors.push(`Missing user.email (${name})`);
      continue;
    }
    if (excluded.includes(email.toLowerCase())) { result.skipped++; continue; }

    const userId = await resolveUser(email, attrs, spans.length);
    if (!userId) continue;

    const sessionId = getAttr(attrs, 'session.id') ?? span.traceId ?? uuidv4();
    const promptId = span.traceId ?? null;
    const product = officeProduct(getAttr(attrs, 'agent.surface'));
    const occurredAt = toSeconds(span.startTimeUnixNano);
    const pending: Pending = { pii: null };

    try {
      await withTx(client, async (tx) => {
        const keyAttrs: OtlpAttr[] = [
          { key: 'span_id', value: { stringValue: span.spanId ?? '' } },
          { key: 'trace_id', value: { stringValue: span.traceId ?? '' } },
        ];
        const eventKey = otelEventKey({ service: OFFICE_SERVICE_NAME, eventName: name, sessionId, attrs: keyAttrs, timeUnixNano: span.startTimeUnixNano });
        if (!(await claimOtelEvent(tx, eventKey, nowS))) { result.skipped++; return; }

        const inserted = await tx
          .insert(schema.coworkSessions)
          .values({
            id: sessionId,
            conversation_id: sessionId,
            user_id: userId,
            org_id: getAttr(attrs, 'organization.id') ?? null,
            source: 'otel',
            product,
            started_at: occurredAt,
            created_at: nowS,
          })
          .onConflictDoNothing()
          .returning({ id: schema.coworkSessions.id });
        if (inserted.length) result.sessionsCreated++;

        if (name === 'agent.query') {
          const prompt = getAttr(attrs, 'user.message') ?? '';
          const messageId = uuidv4();
          let flagged = 0;
          let flagReason: string | null = null;
          const piiMatches = prompt ? detectPiiWithMatches(prompt) : [];
          if (piiMatches.length) {
            flagged = 1;
            flagReason = `PII detected: ${piiMatches.map(m => m.type).join(', ')}`;
            pending.pii = { matches: piiMatches, prompt, messageId };
          }
          const intentMatches = prompt ? detectIntent(prompt, customCategories) : [];
          if (intentMatches.length) {
            flagged = 1;
            const intentReason = `Intent detected: ${intentMatches.map(m => m.categoryId).join(', ')}`;
            flagReason = flagReason ? `${flagReason} | ${intentReason}` : intentReason;
          }

          await tx.insert(schema.coworkMessages).values({
            id: messageId,
            session_id: sessionId,
            user_id: userId,
            message_type: 'cowork_user_message',
            surface: 'cowork',
            source: 'otel',
            product,
            prompt_id: promptId,
            content_preview: prompt.slice(0, CONTENT_PREVIEW_CHARS),
            content_full: prompt.slice(0, CONTENT_FULL_CHARS),
            flagged,
            flag_reason: flagReason,
            occurred_at: occurredAt,
          });
          result.logsInserted++;

          // Name the document on this prompt's tool calls that changed it.
          const docName = documentFileName(getAttr(attrs, 'document.url'));
          // The query span ends after its tool spans, so they are already stored
          // (or earlier in this payload, which handles queries last).
          if (docName && promptId) {
            await tx
              .update(schema.coworkMessages)
              .set({ output_name: docName })
              .where(and(
                eq(schema.coworkMessages.prompt_id, promptId),
                eq(schema.coworkMessages.message_type, 'cowork_tool_metadata'),
                eq(schema.coworkMessages.product, product ?? ''),
                eq(schema.coworkMessages.tool_success, 1),
                sql`${schema.coworkMessages.tool_parameters}->>'changed_document' = 'true'`,
              ));
          }

          if (intentMatches.length) {
            createIntentAlerts(userId, 'cowork', messageId, prompt, intentMatches).catch((e: Error) => {
              console.error('[office-receiver] intent alert error:', e.message);
            });
          }
          return;
        }

        if (name === 'agent.stream') {
          const model = getAttr(attrs, 'model') ?? null;
          if (getAttr(attrs, 'error.name')) {
            await tx.insert(schema.coworkMessages).values({
              id: uuidv4(), session_id: sessionId, user_id: userId,
              message_type: 'cowork_api_error', surface: 'cowork', source: 'otel', product,
              prompt_id: promptId, model, occurred_at: occurredAt,
            });
            result.logsInserted++;
            return;
          }
          const tokenUsage = JSON.stringify({
            inputTokens: getNumber(attrs, 'input_tokens'),
            outputTokens: getNumber(attrs, 'output_tokens'),
            cacheReadTokens: getNumber(attrs, 'cache_read_tokens'),
            cacheCreationTokens: getNumber(attrs, 'cache_creation_tokens'),
          });
          await tx.insert(schema.coworkMessages).values({
            id: uuidv4(), session_id: sessionId, user_id: userId,
            message_type: 'cowork_api_request', surface: 'cowork', source: 'otel', product,
            prompt_id: promptId, model,
            cost_usd: null,
            token_usage: textToJsonValue(tokenUsage) as never,
            content_preview: `${model ?? 'unknown'} | ${tokenUsage}`,
            occurred_at: occurredAt,
          });
          result.logsInserted++;
          return;
        }

        // agent.tool_execution. tool.input and tool.output are never read.
        const toolName = getAttr(attrs, 'tool_name') ?? 'unknown';
        const readWrite = getAttr(attrs, 'tool.read_write');
        const success = getAttr(attrs, 'tool.success') === 'false' ? 0 : 1;
        await tx.insert(schema.coworkMessages).values({
          id: uuidv4(), session_id: sessionId, user_id: userId,
          message_type: 'cowork_tool_metadata', surface: 'cowork', source: 'otel', product,
          prompt_id: promptId,
          tool_success: success,
          tool_duration_ms: durationMs(span),
          content_preview: toolName,
          tool_parameters: textToJsonValue(JSON.stringify({
            read_write: readWrite ?? null,
            changed_document: changedDocument(toolName, readWrite),
            accept_decision: getAttr(attrs, 'tool.accept_decision') ?? null,
            owner: getAttr(attrs, 'tool.owner') ?? null,
          })) as never,
          occurred_at: occurredAt,
        });
        result.logsInserted++;
      });

      if (pending.pii) {
        const pii = pending.pii;
        createPiiAlertsWithDedup(userId, pii.matches, pii.prompt, pii.messageId, 'cowork').catch((e: Error) => {
          console.error('[office-receiver] pii alert error:', e.message);
          void recordPiiAlertFailure('cowork', pii.messageId, e);
        });
      }
    } catch (e) {
      result.errors.push(`Span ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

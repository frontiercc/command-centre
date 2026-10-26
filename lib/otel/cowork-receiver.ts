// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTLP Cowork logs ingest, async Drizzle on Postgres.
// Each log record's writes run in their OWN top-level transaction via withTx,
// with the per-record try/catch OUTSIDE so a failed record is recorded in
// result.errors and the loop continues (each record's transaction rolls back
// independently — no cross-record poisoning, so no savepointEach is needed at
// this granularity).
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { textToJsonValue } from '@/lib/db/json';
import { detectPiiWithMatches, type PiiMatch } from '@/lib/pii/detect';
import { detectIntent } from '@/lib/intent/detect';
import { getCustomCategories } from '@/lib/intent/custom';
import { createIntentAlerts } from '@/lib/alerts/intent-alerts';
import { createPiiAlertsWithDedup } from '@/lib/alerts/pii-alerts';
import { recordPiiAlertFailure } from '@/lib/alerts/pii-alert-failure';
import { extractUploadedFilenames, createFileUploadAlerts } from '@/lib/alerts/file-upload-alerts';
import { isKnownAnthropicSkill } from '@/lib/library/known-anthropic-skills';
import { resolveCodifiedSkillName } from '@/lib/library/codified-skill-name';
import { CONTENT_PREVIEW_CHARS, CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';
import { resolveOtelUser } from '@/lib/otel/resolve-user';
import { recordIngestFailure } from '@/lib/otel/ingest-failure';
import { otelEventKey, claimOtelEvent } from '@/lib/otel/event-key';
import { outputFileName } from '@/lib/otel/output-name';
import { SUBAGENT_LAUNCH_TOOLS, subagentLabel } from '@/lib/otel/subagent';

/** OTLP key-value attribute as it arrives in JSON payloads. */
interface OtlpAttr {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

/** Minimal shape of a parsed OTLP resourceLogs payload. */
interface OtlpLogsPayload {
  resourceLogs?: Array<{
    resource?: { attributes?: OtlpAttr[] };
    scopeLogs?: Array<{
      logRecords?: Array<{
        timeUnixNano?: string;
        attributes?: OtlpAttr[];
      }>;
    }>;
  }>;
}

export interface ProcessResult {
  logsInserted: number;
  skipped: number;
  usersCreated: number;
  sessionsCreated: number;
  alertsFired: number;
  errors: string[];
}

/**
 * Derive a display name from an email address.
 * "jane.smith@example.com" → "Jane Smith"
 * "test@example.com" → "Test"
 * Exported separately — tests import it directly.
 */
export function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .split('.')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function getAttr(attributes: OtlpAttr[], key: string): string | undefined {
  const attr = attributes.find(a => a.key === key);
  if (!attr) return undefined;
  const v = attr.value;
  return v.stringValue ?? v.intValue?.toString() ?? undefined;
}

/**
 * Anthropic marketplace plugin UUIDs confirmed from live OTel payloads.
 * UUIDs are stable and Anthropic-assigned (same UUID for the same plugin across all orgs).
 * Add entries here as new UUIDs are identified in production — UUID → readable name.
 */
const MARKETPLACE_UUID_NAMES: Record<string, string> = {
  '2479fda4-bb8d-4c07-992a-d4b5ee716491': 'Gmail',
  '4e9498bf-b231-4765-a809-807bd146480a': 'Slack',
  'b81b7f4d-1e56-4b5c-a5c0-a99082a41652': 'Salesforce',
  '84b429e1-ea9c-407c-b7be-6fef13c08f10': 'Google Drive',
};

interface SyncedResource {
  name: string;
  uri: string | null;
  mimeType: string | null;
}

/** Parse the <sync_sources> block Claude Desktop injects into user prompts when MCP resources are synced. */
function extractSyncSources(prompt: string): SyncedResource[] {
  const refsMatch = prompt.match(/<refs>([\s\S]*?)(?:<\/refs>|$)/);
  if (!refsMatch) return [];
  try {
    const decoded = decodeURIComponent(refsMatch[1].trim());
    const refs = JSON.parse(decoded);
    if (!Array.isArray(refs)) return [];
    const results: SyncedResource[] = [];
    for (const r of refs) {
      if (!r || typeof r !== 'object' || r.type !== 'mcpres') continue;
      const resource = (r as Record<string, Record<string, Record<string, string>>>).config?.resource;
      if (!resource) continue;
      results.push({
        name: resource.name ?? (r as Record<string, Record<string, string>>).status?.extra ?? 'Unknown',
        uri: resource.uri ?? null,
        mimeType: resource.mimeType ?? null,
      });
    }
    return results;
  } catch {
    return [];
  }
}

/** Strip <sync_sources>…</sync_sources> blocks from a prompt string. */
function stripSyncSources(prompt: string): string {
  return prompt.replace(/<sync_sources>[\s\S]*?<\/sync_sources>/g, '').trim();
}

function getNumericAttr(attributes: OtlpAttr[], key: string): number | null {
  const attr = attributes.find(a => a.key === key);
  if (!attr) return null;
  const v = attr.value;
  if (v.doubleValue != null) return v.doubleValue;
  if (v.intValue != null) return Number(v.intValue);
  if (v.stringValue != null) {
    const n = parseFloat(v.stringValue);
    return isNaN(n) ? null : n;
  }
  return null;
}

type PendingPiiAlert = { piiMatches: PiiMatch[]; prompt: string; messageId: string } | null;

/**
 * Fires a deferred PII alert captured during the sync db.transaction()
 * callback (see the `pendingPiiAlert` comment at its declaration site
 * below). Deliberately a standalone function rather than an inline
 * `if (pendingPiiAlert) { ... pendingPiiAlert.piiMatches ... }` block: a `let`
 * variable that's ONLY ever assigned inside a nested closure has its
 * assignment invisible to TypeScript's control-flow analysis at the outer
 * call site, so the compiler narrows `if (pendingPiiAlert)` to `never`
 * rather than the object type — `never.piiMatches` is then a hard type error.
 * Passing the same value as a plain function ARGUMENT doesn't hit this
 * (`never` is assignable to anything), which is why `pendingFileUploadFilenames`
 * two lines below never needed this treatment — but this call needs to
 * access two named fields, so it gets its own narrowing scope via the
 * parameter binding instead.
 */
async function firePendingPiiAlert(
  userId: string,
  pending: PendingPiiAlert,
): Promise<void> {
  if (!pending) return;
  await createPiiAlertsWithDedup(userId, pending.piiMatches, pending.prompt, pending.messageId, 'cowork');
}


/**
 * Process an OTLP Logs payload (resourceLogs), routing each claude_code.* event
 * to the appropriate cowork tables.
 *
 * Event routing:
 *   claude_code.user_prompt   → cowork_messages (message_type=cowork_user_message)
 *   claude_code.tool_result   → cowork_messages (message_type=cowork_tool_metadata) + cowork_mcp_invocations if mcp_server_scope set
 *   claude_code.skill_activated → cowork_skill_invocations ONLY (no cowork_messages row)
 *   claude_code.api_request   → cowork_messages (message_type=cowork_api_request)
 *   claude_code.api_error     → cowork_messages (message_type=cowork_api_error)
 *   claude_code.tool_decision → otel_events ONLY (no cowork_messages row)
 *   everything else           → skipped (result.skipped++)
 *
 * All cowork_messages inserts: source='otel', surface='cowork'.
 */
export async function processOtlpLogs(payload: unknown): Promise<ProcessResult> {
  const result: ProcessResult = {
    logsInserted: 0,
    skipped: 0,
    usersCreated: 0,
    sessionsCreated: 0,
    alertsFired: 0,
    errors: [],
  };

  const p = payload as OtlpLogsPayload;
  if (!p?.resourceLogs?.length) {
    result.errors.push('No resourceLogs in payload');
    return result;
  }

  const client = await getTypedClient();

  // Load custom intent categories once per payload. getCustomCategories is
  // now async — await once, before the resourceLogs loop below,
  // preserving the existing "fetched once per payload" behaviour.
  const customCategories = await getCustomCategories();

  for (const resourceLog of p.resourceLogs) {
    const resAttrs: OtlpAttr[] = resourceLog.resource?.attributes ?? [];

    // Only process Cowork Desktop events. Code CLI events (service.name='claude-code')
    // are routed to lib/otel/code-receiver by the ingest route.
    const serviceName = getAttr(resAttrs, 'service.name') ?? '';
    if (serviceName !== 'cowork') {
      result.skipped++;
      continue;
    }

    // Claude Code CLI puts identity in resource attrs; Cowork Desktop puts it in each
    // log record's attrs. Fall back to the first record when resource attrs are empty.
    const firstRecordAttrs: OtlpAttr[] =
      resourceLog.scopeLogs?.[0]?.logRecords?.[0]?.attributes ?? [];
    const identityAttrs = (key: string) =>
      getAttr(resAttrs, key) ?? getAttr(firstRecordAttrs, key);

    const email = identityAttrs('user.email');
    const userId = identityAttrs('user.id') ?? uuidv4();
    const accountUuid = identityAttrs('user.account_uuid') ?? null;
    const orgId = identityAttrs('organization.id') ?? null;
    // department via OTEL_RESOURCE_ATTRIBUTES custom key — no OTel standard for this
    const department =
      identityAttrs('department') ?? identityAttrs('team.id') ?? null;

    if (!email) {
      result.errors.push(`Missing user.email (userId=${userId})`);
      continue;
    }

    // Drop events for excluded emails
    const excludedRows = await client
      .select({ value: schema.config.value })
      .from(schema.config)
      .where(eq(schema.config.key, 'otel_excluded_emails'))
      .limit(1);
    if (excludedRows[0]?.value) {
      try {
        const excluded: string[] = JSON.parse(excludedRows[0].value);
        if (excluded.some(e => e.trim().toLowerCase() === email.toLowerCase())) {
          result.skipped++;
          continue;
        }
      } catch { /* malformed config — ignore */ }
    }

    const displayName = displayNameFromEmail(email);
    const nowS = Math.floor(Date.now() / 1000); // app clock

    // Resolve the person (lib/otel/resolve-user.ts): alias → email (any case) →
    // create under the installation id only when nobody else holds it. A second
    // Claude account on the same machine used to 500 the whole batch here.
    // Isolated per resource so one account can never fail the rest of the request.
    let resolvedUserId: string;
    try {
      const recordCount = (resourceLog.scopeLogs ?? []).reduce((n, s) => n + (s.logRecords?.length ?? 0), 0);
      const resolved = await resolveOtelUser(client, {
        email, installationId: identityAttrs('user.id') ?? null, displayName, department,
        accountUuid, surface: 'cowork', nowS, eventCount: recordCount,
      });
      resolvedUserId = resolved.userId;
      if (resolved.created) result.usersCreated++;
      if (resolved.existing) {
        // Update last_seen_at; backfill account_uuid / department if null; preserve source
        await client
          .update(schema.users)
          .set({
            last_seen_at: nowS,
            account_uuid: sql`COALESCE(${schema.users.account_uuid}, ${accountUuid})`,
            department: sql`COALESCE(${schema.users.department}, ${department})`,
            source: sql`CASE WHEN ${schema.users.source} = 'agent' THEN 'agent' ELSE 'otel' END`,
          })
          .where(eq(schema.users.id, resolvedUserId));

        // Backfill linked_cowork_user_id for pre-enrolled admin_users rows that
        // were created before OTel events arrived (COALESCE is a no-op if already set).
        // Also mirror admin_users.department → users.department so Pulse dashboards work.
        await client
          .update(schema.adminUsers)
          .set({ linked_cowork_user_id: sql`COALESCE(${schema.adminUsers.linked_cowork_user_id}, ${resolvedUserId})` })
          .where(eq(schema.adminUsers.email, email.toLowerCase()));
        await client
          .update(schema.users)
          .set({
            department: sql`COALESCE(${schema.users.department}, (SELECT department FROM admin_users WHERE email = ${email.toLowerCase()} AND department IS NOT NULL LIMIT 1))`,
          })
          .where(eq(schema.users.id, resolvedUserId));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Identity resolution failed, resource skipped: ${message}`);
      await recordIngestFailure('otel-ingest-identity', message, { surface: 'cowork', records: (resourceLog.scopeLogs ?? []).reduce((n, s) => n + (s.logRecords?.length ?? 0), 0) });
      continue;
    }

    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const attrs: OtlpAttr[] = record.attributes ?? [];
        // Normalise: Claude Desktop sends bare names ('user_prompt'); our tests use 'claude_code.*'
        const rawEventName = getAttr(attrs, 'event.name') ?? '';
        const eventName = rawEventName.startsWith('claude_code.') ? rawEventName : `claude_code.${rawEventName}`;
        const sessionId = getAttr(attrs, 'session.id') ?? uuidv4();
        const promptId = getAttr(attrs, 'prompt.id') ?? null;

        // Convert nanosecond timestamp to Unix seconds
        // Use string parsing to avoid BigInt literal syntax (targets pre-ES2020)
        const occurredAt = record.timeUnixNano
          ? Math.floor(Number(record.timeUnixNano) / 1_000_000_000)
          : Math.floor(Date.now() / 1000);

        // Ensure session exists (INSERT OR IGNORE is safe for concurrent ingest)
        const sessionRows = await client
          .select({ id: schema.coworkSessions.id })
          .from(schema.coworkSessions)
          .where(eq(schema.coworkSessions.id, sessionId))
          .limit(1);
        if (!sessionRows.length) {
          await client
            .insert(schema.coworkSessions)
            .values({
              id: sessionId,
              user_id: resolvedUserId,
              org_id: orgId,
              source: 'otel',
              started_at: occurredAt,
              created_at: Math.floor(Date.now() / 1000),
              conversation_id: sessionId,
            })
            .onConflictDoNothing();
          result.sessionsCreated++;
        }

        // createPiiAlertsWithDedup and createFileUploadAlerts are both async
        // (Phase 3 — they call the converted insertAlert). Their inputs are
        // captured here during the transaction and the real calls happen
        // AFTER processRecord() commits, so neither can write an alert for a
        // record that never became durable.
        // They differ from each other past that point:
        //   - createFileUploadAlerts is still AWAITED, so its failures land
        //     in result.errors and its count merges into result.alertsFired.
        //     It is pure pattern matching with no model call.
        //   - createPiiAlertsWithDedup is FIRE-AND-FORGET with .catch(),
        //     matching the createIntentAlerts idiom, because it now makes a
        //     Claude call (the shape-only confirmation check) and a model
        //     call must never sit inside ingest request handling. Its
        //     failures are logged, not returned, and result.alertsFired no
        //     longer counts PII alerts at all.
        let pendingPiiAlert: PendingPiiAlert = null;
        let pendingFileUploadFilenames: string[] | null = null;

        try {
          // Wrap all DB writes for a single log record in ITS OWN top-level
          // transaction (withTx) so a mid-write failure never leaves orphaned
          // rows. The per-record try/catch stays OUTSIDE, so a failed record is
          // recorded in result.errors and the loop continues; on Postgres each
          // record's transaction rolls back independently (no cross-record
          // poisoning), so no savepointEach is needed at this granularity.
          await withTx(client, async (tx) => {
            // A re-delivered record (collector retry) was stored the first time:
            // skip it whole, so nothing is inserted or counted twice. The claim
            // commits or rolls back with this record's writes.
            const eventKey = otelEventKey({ service: serviceName, eventName, sessionId: getAttr(attrs, 'session.id') ?? '', attrs, timeUnixNano: record.timeUnixNano });
            if (!(await claimOtelEvent(tx, eventKey, nowS))) { result.skipped++; return; }
            switch (eventName) {
              case 'claude_code.user_prompt': {
                const rawPrompt = getAttr(attrs, 'prompt') ?? '';
                const syncedResources = extractSyncSources(rawPrompt);
                const prompt = syncedResources.length > 0 ? stripSyncSources(rawPrompt) : rawPrompt;
                const isRedacted = prompt === '<REDACTED>';
                const messageId = uuidv4();
                let flagged = 0;
                let flagReason: string | null = null;

                if (!isRedacted) {
                  const piiMatches = detectPiiWithMatches(prompt);
                  if (piiMatches.length > 0) {
                    flagged = 1;
                    flagReason = `PII detected: ${piiMatches.map((m) => m.type).join(', ')}`;
                    // Deferred to after the withTx commits — see comment above
                    // the `try` block for this record. result.alertsFired is
                    // incremented after the deferred call succeeds (not
                    // here), so a write failure lands in result.errors
                    // instead of an optimistic count.
                    pendingPiiAlert = { piiMatches, prompt, messageId };
                  }
                }

                // Intent detection — synchronous check sets flagged/flag_reason before insert
                // so the audit log shows the message as flagged immediately. The async
                // createIntentAlerts call below then enriches flag_reason with AI-assessed severity.
                let intentMatches: ReturnType<typeof detectIntent> = [];
                if (!isRedacted) {
                  intentMatches = detectIntent(prompt, customCategories);
                  if (intentMatches.length > 0) {
                    flagged = 1;
                    const categories = intentMatches.map(m => m.categoryId).join(', ');
                    const intentReason = `Intent detected: ${categories}`;
                    flagReason = flagReason ? `${flagReason} | ${intentReason}` : intentReason;
                  }
                }

                await tx.insert(schema.coworkMessages).values({
                  id: messageId,
                  session_id: sessionId,
                  user_id: resolvedUserId,
                  message_type: 'cowork_user_message',
                  surface: 'cowork',
                  source: 'otel',
                  prompt_id: promptId,
                  content_preview: prompt.slice(0, CONTENT_PREVIEW_CHARS),
                  content_full: prompt.slice(0, CONTENT_FULL_CHARS),
                  flagged,
                  flag_reason: flagReason,
                  synced_resources: syncedResources.length > 0 ? JSON.stringify(syncedResources) : null,
                  occurred_at: occurredAt,
                });
                result.logsInserted++;

                // File upload extraction — parse <uploaded_files> XML, store filenames
                // on the session and fire pattern-matched alerts.
                if (!isRedacted) {
                  const uploadedFilenames = extractUploadedFilenames(prompt);
                  if (uploadedFilenames.length > 0) {
                    // Merge new filenames into cowork_sessions.files_uploaded (JSON union)
                    const sessionRow = (await tx
                      .select({ files_uploaded: schema.coworkSessions.files_uploaded })
                      .from(schema.coworkSessions)
                      .where(eq(schema.coworkSessions.id, sessionId))
                      .limit(1))[0];
                    const existingFiles: string[] = sessionRow?.files_uploaded
                      ? (() => { try { return JSON.parse(sessionRow.files_uploaded!); } catch { return []; } })()
                      : [];
                    const merged = Array.from(new Set([...existingFiles, ...uploadedFilenames]));
                    await tx
                      .update(schema.coworkSessions)
                      .set({ files_uploaded: JSON.stringify(merged) })
                      .where(eq(schema.coworkSessions.id, sessionId));

                    // Deferred to after the withTx commits — see comment above the
                    // `try` block for this record.
                    pendingFileUploadFilenames = uploadedFilenames;
                  }
                }

                // Intent alerts — async AI assessment enriches flag_reason with (severity)
                if (!isRedacted && intentMatches.length > 0) {
                  createIntentAlerts(
                    resolvedUserId,
                    'cowork',
                    messageId,
                    prompt,
                    intentMatches,
                  ).catch((e: Error) => {
                    console.error('[otel-receiver] intent alert error:', e.message);
                  });
                }
                break;
              }

              case 'claude_code.tool_result': {
                const toolName = getAttr(attrs, 'tool_name') ?? 'unknown';
                const mcpScope = getAttr(attrs, 'mcp_server_scope');
                const success = (getAttr(attrs, 'success') ?? 'true') === 'true' ? 1 : 0;
                const durationMs = getNumericAttr(attrs, 'duration_ms');
                const toolParamsStr = getAttr(attrs, 'tool_parameters');
                const toolParams = toolParamsStr
                  ? (() => { try { return JSON.parse(toolParamsStr); } catch { return null; } })()
                  : null;

                // Insert MCP invocation row when this tool_result came from an MCP server.
                // Custom MCP servers send a readable name; Anthropic marketplace plugins send
                // a stable UUID — resolved via MARKETPLACE_UUID_NAMES. Unknown UUIDs are skipped
                // until the UUID is identified and added to the lookup.
                const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
                if (mcpScope) {
                  const rawName = toolParams?.mcp_server_name ?? mcpScope;
                  const mcpServerName = (rawName && !isUuid(rawName))
                    ? rawName
                    : (rawName ? MARKETPLACE_UUID_NAMES[rawName.toLowerCase()] ?? null : null);
                  if (!mcpServerName) break; // unknown UUID — skip until identified
                  await tx.insert(schema.coworkMcpInvocations).values({
                    id: uuidv4(),
                    user_id: resolvedUserId,
                    session_id: sessionId,
                    mcp_server: mcpServerName,
                    mcp_tool: toolParams?.mcp_tool_name ?? toolName,
                    success,
                    duration_ms: durationMs,
                    source: 'otel',
                    prompt_id: promptId,
                    occurred_at: occurredAt,
                  }).onConflictDoNothing();
                  // Auto-register connector in the library (exclude system connectors).
                  // Connectors resolved from a known Anthropic UUID are pre-published as 'anthropic'.
                  // Custom org connectors appear as unclaimed (is_published=0, source='org').
                  if (!['workspace', 'cowork', 'Claude_in_Chrome'].includes(mcpServerName)) {
                    const isAnthropicMarketplace = rawName != null && isUuid(rawName) && MARKETPLACE_UUID_NAMES[rawName.toLowerCase()] != null;
                    const nowSec = Math.floor(Date.now() / 1000);
                    if (isAnthropicMarketplace) {
                      await tx.insert(schema.skillLibraryEntries).values({
                        name: mcpServerName, type: 'connector', surface: 'cowork',
                        source: 'anthropic', is_published: 1, created_at: nowSec, updated_at: nowSec,
                      }).onConflictDoUpdate({
                        target: schema.skillLibraryEntries.name,
                        set: { source: 'anthropic', is_published: 1, updated_at: sql`excluded.updated_at` },
                      });
                    } else {
                      await tx.insert(schema.skillLibraryEntries).values({
                        name: mcpServerName, type: 'connector', surface: 'cowork',
                        source: 'org', is_published: 0, created_at: nowSec, updated_at: nowSec,
                      }).onConflictDoNothing();
                    }
                  }
                }

                // Skip cowork_messages for system connector tool calls — workspace/cowork/
                // Claude_in_Chrome are infrastructure-level and add noise to the audit log.
                const isSystemConnectorCall = mcpScope != null &&
                  ['workspace', 'cowork', 'Claude_in_Chrome'].includes(toolParams?.mcp_server_name ?? mcpScope);
                if (!isSystemConnectorCall) {
                  await tx.insert(schema.coworkMessages).values({
                    id: uuidv4(),
                    session_id: sessionId,
                    user_id: resolvedUserId,
                    message_type: 'cowork_tool_metadata',
                    surface: 'cowork',
                    source: 'otel',
                    prompt_id: promptId,
                    tool_success: success,
                    tool_duration_ms: durationMs,
                    content_preview: toolName,
                    // File name only, for a successful output tool call (frontier
                    // boxes, migration 0028). Content and directories are discarded.
                    output_name: success === 1 ? outputFileName(toolName, toolParams, getAttr(attrs, 'tool_input')) : null,
                    // A subagent launch keeps only the subagent's type from the tool's
                    // parameters (migration 0036). tool_input holds the prompt and is never read here.
                    agent_name: SUBAGENT_LAUNCH_TOOLS.has(toolName) ? subagentLabel(toolParams?.subagent_type) : null,
                    occurred_at: occurredAt,
                  });
                  result.logsInserted++;
                }
                break;
              }

              case 'claude_code.skill_activated': {
                // skill_activated goes to cowork_skill_invocations ONLY — no cowork_messages row.
                const rawSkillName = getAttr(attrs, 'skill.name') ?? 'custom_skill';
                // Names on the known-Anthropic allowlist are never normalised
                // — that check runs on the RAW name first. Otherwise a
                // marketplace-prefixed name whose bare suffix is a codified
                // Board skill ("acme-library:x") is stored under the
                // Board name — see lib/library/codified-skill-name.ts.
                const anthropicSkill = isKnownAnthropicSkill(rawSkillName);
                const resolved = anthropicSkill
                  ? { name: rawSkillName, codified: false }
                  : await resolveCodifiedSkillName(tx, rawSkillName);
                const skillName = resolved.name;
                await tx.insert(schema.coworkSkillInvocations).values({
                  id: uuidv4(),
                  user_id: resolvedUserId,
                  session_id: sessionId,
                  skill_name: skillName,
                  source: 'otel',
                  prompt_id: promptId,
                  occurred_at: occurredAt,
                });
                // Auto-register in the library so the board shows real counts.
                // Known Anthropic-bundled skills (docx, xlsx, ...) auto-publish — same
                // treatment as an Anthropic marketplace connector above — since there's no
                // real org owner to claim them; everything else lands unclaimed as usual.
                const nowSec = Math.floor(Date.now() / 1000);
                if (anthropicSkill) {
                  await tx.insert(schema.skillLibraryEntries).values({
                    name: skillName, type: 'skill', surface: 'cowork',
                    source: 'anthropic', is_published: 1, created_at: nowSec, updated_at: nowSec,
                  }).onConflictDoUpdate({
                    target: schema.skillLibraryEntries.name,
                    set: { source: 'anthropic', is_published: 1, updated_at: sql`excluded.updated_at` },
                  });
                } else if (!resolved.codified) {
                  // A codified skill already has its (claimed) Board entry, so
                  // nothing is registered for it. A plain codified name also
                  // lands here and is a no-op on the name conflict.
                  await tx.insert(schema.skillLibraryEntries).values({
                    name: skillName, type: 'skill', surface: 'cowork',
                    source: 'org', is_published: 0, created_at: nowSec, updated_at: nowSec,
                  }).onConflictDoNothing();
                }
                result.logsInserted++;
                break;
              }

              case 'claude_code.api_request': {
                const model = getAttr(attrs, 'model') ?? null;
                const costUsd = getNumericAttr(attrs, 'cost_usd');
                const tokenUsage = JSON.stringify({
                  inputTokens: getNumericAttr(attrs, 'input_tokens'),
                  outputTokens: getNumericAttr(attrs, 'output_tokens'),
                  cacheReadTokens: getNumericAttr(attrs, 'cache_read_tokens'),
                  cacheCreationTokens: getNumericAttr(attrs, 'cache_creation_tokens'),
                });

                await tx.insert(schema.coworkMessages).values({
                  id: uuidv4(),
                  session_id: sessionId,
                  user_id: resolvedUserId,
                  message_type: 'cowork_api_request',
                  surface: 'cowork',
                  source: 'otel',
                  prompt_id: promptId,
                  model,
                  cost_usd: costUsd !== null ? String(costUsd) : null,
                  // jsonb Policy A (WRITE): textToJsonValue parses the JSON
                  // string to a JS value for pg's jsonb codec so a jsonToText
                  // read round-trips to the same string.
                  token_usage: textToJsonValue(tokenUsage) as never,
                  content_preview: `${model ?? 'unknown'} | ${tokenUsage}`,
                  // Subagent attribution, as code_assistant_meta keeps it (migration 0036).
                  agent_name: subagentLabel(getAttr(attrs, 'agent.name')),
                  query_source: subagentLabel(getAttr(attrs, 'query_source')),
                  skill_name: subagentLabel(getAttr(attrs, 'skill.name')),
                  occurred_at: occurredAt,
                });
                result.logsInserted++;
                break;
              }

              case 'claude_code.api_error': {
                await tx.insert(schema.coworkMessages).values({
                  id: uuidv4(),
                  session_id: sessionId,
                  user_id: resolvedUserId,
                  message_type: 'cowork_api_error',
                  surface: 'cowork',
                  source: 'otel',
                  prompt_id: promptId,
                  occurred_at: occurredAt,
                });
                result.logsInserted++;
                break;
              }

              case 'claude_code.tool_decision': {
                // tool_decision goes to otel_events ONLY — no cowork_messages row.
                const toolName = getAttr(attrs, 'tool_name') ?? 'unknown';
                await tx.insert(schema.otelEvents).values({
                  id: uuidv4(),
                  session_id: sessionId,
                  user_id: resolvedUserId,
                  event_type: 'tool_decision',
                  source: 'otel',
                  prompt_id: promptId,
                  tool_name: toolName,
                  // jsonb Policy A (WRITE) — see the api_request case above.
                  tool_input: textToJsonValue(JSON.stringify({
                    decision: getAttr(attrs, 'decision'),
                    source: getAttr(attrs, 'source'),
                  })) as never,
                  occurred_at: occurredAt,
                });
                result.logsInserted++;
                break;
              }

              default:
                // Unknown claude_code.* event — skip silently
                result.skipped++;
                break;
            }
          });
          // Fire-and-forget: the confirmation check inside makes a Claude call,
          // and a model call must never sit inside OTel request handling (the
          // per-insert Slack design was scrapped in an earlier release for exactly
          // this). Mirrors the createIntentAlerts idiom above.
          // NOTE: result.alertsFired no longer counts PII alerts. It still
          // counts file-upload alerts below, which are pure pattern matching.
          // A failure here must not vanish. The call is fire-and-forget (it
          // makes a Claude call and must not block ingest), so it can no
          // longer report into result.errors the way it did when it was
          // awaited — but a PII alert that silently fails to write is a
          // security signal lost, which is exactly what the awaited version
          // was introduced to prevent. It is recorded in error_events instead,
          // which is durable, admin-visible and on its own retention window.
          firePendingPiiAlert(resolvedUserId, pendingPiiAlert).catch((e: Error) => {
            console.error('[otel-receiver] pii alert error:', e.message);
            void recordPiiAlertFailure('cowork', pendingPiiAlert?.messageId, e);
          });
          if (pendingFileUploadFilenames) {
            const alertsFired = await createFileUploadAlerts(resolvedUserId, sessionId, pendingFileUploadFilenames);
            result.alertsFired += alertsFired;
          }
        } catch (e) {
          result.errors.push(`Event ${eventName}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}

export default processOtlpLogs;

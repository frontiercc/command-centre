// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTLP Code CLI logs ingest, async Drizzle on Postgres.
// Each log record's writes run in their OWN top-level transaction via withTx,
// with the per-record try/catch OUTSIDE so a failed record is recorded and the
// loop continues (each record's transaction rolls back independently —
// no cross-record poisoning, so no savepointEach is needed at this granularity).
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { detectPiiWithMatches, type PiiMatch } from '@/lib/pii/detect';
import { detectIntent } from '@/lib/intent/detect';
import { getCustomCategories } from '@/lib/intent/custom';
import { createIntentAlerts } from '@/lib/alerts/intent-alerts';
import { createPiiAlertsWithDedup } from '@/lib/alerts/pii-alerts';
import { recordPiiAlertFailure } from '@/lib/alerts/pii-alert-failure';
import { isKnownAnthropicSkill } from '@/lib/library/known-anthropic-skills';
import { resolveCodifiedSkillName } from '@/lib/library/codified-skill-name';
import { CONTENT_PREVIEW_CHARS, CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';
import { resolveOtelUser } from '@/lib/otel/resolve-user';
import { recordIngestFailure } from '@/lib/otel/ingest-failure';
import { otelEventKey, claimOtelEvent } from '@/lib/otel/event-key';

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
  processed: number;
  skipped: number;
  errors: string[];
}

/**
 * Derive a display name from an email address.
 * "jane.smith@example.com" → "Jane Smith"
 */
function displayNameFromEmail(email: string): string {
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

/**
 * Anthropic marketplace plugin UUIDs — same lookup as cowork-receiver.
 * Add entries here as new UUIDs are confirmed from production logs.
 */
const MARKETPLACE_UUID_NAMES: Record<string, string> = {
  '2479fda4-bb8d-4c07-992a-d4b5ee716491': 'Gmail',
  '4e9498bf-b231-4765-a809-807bd146480a': 'Slack',
  'b81b7f4d-1e56-4b5c-a5c0-a99082a41652': 'Salesforce',
  '84b429e1-ea9c-407c-b7be-6fef13c08f10': 'Google Drive',
};

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

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
 * Passing the same value as a plain function argument doesn't hit this
 * (`never` is assignable to anything) — but this call needs to access two
 * named fields, so it gets its own narrowing scope via the parameter
 * binding instead. (Same helper exists in cowork-receiver.ts.)
 */
async function firePendingPiiAlert(
  userId: string,
  pending: PendingPiiAlert,
): Promise<void> {
  if (!pending) return;
  await createPiiAlertsWithDedup(userId, pending.piiMatches, pending.prompt, pending.messageId, 'code');
}


/**
 * Process an OTLP Logs payload (resourceLogs) for Claude Code CLI events
 * (service.name='claude-code'), routing each event to the appropriate Developer Pulse tables.
 *
 * Event routing:
 *   claude_code.user_prompt        → cowork_messages (surface='code', message_type='code_user_message')
 *                                    with PII + intent detection
 *   claude_code.api_request        → code_assistant_meta (source='otel', INSERT OR IGNORE)
 *   claude_code.tool_decision      → UPDATE tool_use_count+1 on the api_request row (one event per tool)
 *   claude_code.tool_result        → code_assistant_meta:
 *     success=false                  Friction row (model='', error_count=1, INSERT OR IGNORE)
 *     success=true, tool_name=Bash,  If tool_parameters contains git_commit_id key:
 *       git_commit_id present          UPDATE commit_count+1 on the api_request row (count only, SHA never stored)
 *   claude_code.skill_activated    → cowork_skill_invocations (source='otel') + upsert skill_library_entries
 *   everything else                → skipped (result.skipped++)
 *
 * No otel_events table writes. No cowork_sessions inserts (Code sessions tracked via code_session_stats).
 */
/**
 * The ONE row per prompt that carries its tool-use and commit counters: the
 * prompt's earliest model call. A prompt now has a row per model call, so an
 * increment matched on session + prompt would land on every one of them and
 * count each tool use about four times. Readers sum per session or per day, so
 * which row carries the count does not matter — only that exactly one does.
 * Postgres UPDATE has no LIMIT, hence the subquery. A NULL promptId matches
 * nothing (unchanged from before).
 */
function firstModelCallOfPrompt(sessionId: string, promptId: string | null) {
  return sql`id = (SELECT id FROM code_assistant_meta WHERE session_id = ${sessionId} AND prompt_id = ${promptId} AND model != '' ORDER BY occurred_at, id LIMIT 1)`;
}

export async function processCodeOtlpLogs(payload: unknown): Promise<ProcessResult> {
  const result: ProcessResult = {
    processed: 0,
    skipped: 0,
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

  // Load excluded emails once per payload — avoids a DB query on every resource iteration
  const excludedRows = await client
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, 'otel_excluded_emails'))
    .limit(1);
  let excludedEmails: string[] = [];
  if (excludedRows[0]?.value) {
    try {
      excludedEmails = JSON.parse(excludedRows[0].value);
    } catch { /* malformed config — ignore */ }
  }

  for (const resourceLog of p.resourceLogs) {
    const resAttrs: OtlpAttr[] = resourceLog.resource?.attributes ?? [];

    // Only process Claude Code CLI events. Cowork Desktop events (service.name='cowork')
    // are routed to lib/otel/cowork-receiver by the ingest route.
    // Accept the whole claude-code* family: 'claude-code' (terminal CLI) and
    // 'claude-code-desktop' (Desktop app, confirmed from live OTel capture), plus
    // any future 'claude-code-*' entrypoint. Cowork events (service.name='cowork')
    // are routed elsewhere by the ingest route.
    const serviceName = getAttr(resAttrs, 'service.name') ?? '';
    if (serviceName !== 'claude-code' && !serviceName.startsWith('claude-code-')) {
      result.skipped++;
      continue;
    }

    // Identity resolution. Per the Claude Code OTel spec, the OTLP resource block
    // carries only service.name/version + os/host; identity (user.email, user.id,
    // organization.id) is a "standard attribute" emitted on each LOG RECORD, not on
    // the resource. Read the resource first (covers hand-crafted/test payloads) then
    // fall back to the first record's attrs — identical to cowork-receiver.ts.
    const firstRecordAttrs: OtlpAttr[] =
      resourceLog.scopeLogs?.[0]?.logRecords?.[0]?.attributes ?? [];
    const identityAttr = (key: string) =>
      getAttr(resAttrs, key) ?? getAttr(firstRecordAttrs, key);

    const email = identityAttr('user.email');
    const userId = identityAttr('user.id') ?? uuidv4();
    const department =
      identityAttr('department') ?? identityAttr('team.id') ?? null;

    if (!email) {
      result.errors.push(`Missing user.email (userId=${userId})`);
      continue;
    }

    // Drop events for excluded emails
    if (excludedEmails.some(e => e.trim().toLowerCase() === email.toLowerCase())) {
      result.skipped++;
      continue;
    }

    const displayName = displayNameFromEmail(email);
    const nowS = Math.floor(Date.now() / 1000); // app clock

    // Resolve the person (lib/otel/resolve-user.ts): alias → email (any case) →
    // create under the installation id only when nobody else holds it. Claude
    // Code's user.id is an installation id (~/.claude.json), so a second Claude
    // account on the same machine used to 500 the whole batch here. Isolated per
    // resource so one account can never fail the rest of the request.
    let resolvedUserId: string;
    try {
      const recordCount = (resourceLog.scopeLogs ?? []).reduce((n, s) => n + (s.logRecords?.length ?? 0), 0);
      const resolved = await resolveOtelUser(client, {
        email, installationId: identityAttr('user.id') ?? null, displayName, department,
        surface: 'code', nowS, eventCount: recordCount,
      });
      resolvedUserId = resolved.userId;
      if (resolved.existing) {
        await client
          .update(schema.users)
          .set({
            last_seen_at: nowS,
            department: sql`COALESCE(${schema.users.department}, ${department})`,
            source: sql`CASE WHEN ${schema.users.source} = 'agent' THEN 'agent' ELSE 'otel' END`,
          })
          .where(eq(schema.users.id, resolvedUserId));

        // Backfill linked_cowork_user_id for pre-enrolled admin_users rows
        await client
          .update(schema.adminUsers)
          .set({ linked_cowork_user_id: sql`COALESCE(${schema.adminUsers.linked_cowork_user_id}, ${resolvedUserId})` })
          .where(eq(schema.adminUsers.email, email.toLowerCase()));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Identity resolution failed, resource skipped: ${message}`);
      await recordIngestFailure('otel-ingest-identity', message, { surface: 'code', records: (resourceLog.scopeLogs ?? []).reduce((n, s) => n + (s.logRecords?.length ?? 0), 0) });
      continue;
    }

    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const attrs: OtlpAttr[] = record.attributes ?? [];

        // Normalise: accept both bare names ('user_prompt') and prefixed ('claude_code.user_prompt')
        const rawEventName = getAttr(attrs, 'event.name') ?? '';
        const eventName = rawEventName.startsWith('claude_code.')
          ? rawEventName
          : `claude_code.${rawEventName}`;

        const sessionId = getAttr(attrs, 'session.id') ?? uuidv4();
        const promptId = getAttr(attrs, 'prompt.id') ?? null;

        // Convert nanosecond timestamp to Unix seconds.
        // Use string parsing to avoid BigInt literal syntax (targets pre-ES2020).
        const occurredAt = record.timeUnixNano
          ? Math.floor(Number(record.timeUnixNano) / 1_000_000_000)
          : Math.floor(Date.now() / 1000);

        // createPiiAlertsWithDedup is async (Phase 3 — it calls the
        // converted insertAlert). Its inputs are captured here during the
        // transaction and the real call happens AFTER processRecord()
        // commits, so an alert can never be written for a record that never
        // became durable.
        // That call is FIRE-AND-FORGET with .catch(), matching
        // the createIntentAlerts idiom just below, because it now makes a
        // Claude call (the shape-only confirmation check) and a model call
        // must never sit inside ingest request handling. Its failures are
        // logged rather than returned in result.errors. This receiver has no
        // alertsFired counter and none is wanted — it raises no file-upload
        // alerts, so one would only ever read zero.
        let pendingPiiAlert: PendingPiiAlert = null;

        try {
          // Wrap all DB writes for a single log record in ITS OWN top-level
          // transaction (withTx) so a mid-write failure never leaves orphaned
          // rows. The per-record try/catch stays OUTSIDE (a failed record is
          // recorded and the loop continues); on Postgres each record's
          // transaction rolls back independently, so no savepointEach is needed
          // at this granularity.
          // Stable per-record key (lib/otel/event-key.ts): the api row's id, the
          // friction row's id, and the "already processed" claim below.
          const eventKey = otelEventKey({ service: serviceName, eventName, sessionId: getAttr(attrs, 'session.id') ?? '', attrs, timeUnixNano: record.timeUnixNano });
          await withTx(client, async (tx) => {
            // A re-delivered record (collector retry) was stored the first time:
            // skip it whole, so nothing is inserted or counted twice.
            if (!(await claimOtelEvent(tx, eventKey, nowS))) { result.skipped++; return; }
            switch (eventName) {
              case 'claude_code.user_prompt': {
                // PII and intent detection on the prompt text.
                // Privacy: only content_preview/content_full stored, capped at
                // CONTENT_PREVIEW_CHARS/CONTENT_FULL_CHARS (lib/otel/content-limits.ts).
                // Never store assistant text.
                const prompt = getAttr(attrs, 'prompt') ?? '';
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
                    // the `try` block for this record.
                    pendingPiiAlert = { piiMatches, prompt, messageId };
                  }
                }

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
                  message_type: 'code_user_message',
                  surface: 'code',
                  source: 'otel',
                  prompt_id: promptId,
                  content_preview: prompt.slice(0, CONTENT_PREVIEW_CHARS),
                  content_full: prompt.slice(0, CONTENT_FULL_CHARS),
                  flagged,
                  flag_reason: flagReason,
                  occurred_at: occurredAt,
                });
                result.processed++;

                // Intent alerts — async AI assessment enriches flag_reason post-insert
                if (!isRedacted && intentMatches.length > 0) {
                  createIntentAlerts(
                    resolvedUserId,
                    'code',
                    messageId,
                    prompt,
                    intentMatches,
                  ).catch((e: Error) => {
                    console.error('[code-otel-receiver] intent alert error:', e.message);
                  });
                }
                break;
              }

              case 'claude_code.api_request': {
                // Insert a metadata row into code_assistant_meta for each API turn.
                // tool_use_count starts at 0; tool_decision events increment it as they arrive.
                const model = getAttr(attrs, 'model') ?? '';
                const inputTokens = getNumericAttr(attrs, 'input_tokens') ?? 0;
                const outputTokens = getNumericAttr(attrs, 'output_tokens') ?? 0;
                const cacheCreationTokens = getNumericAttr(attrs, 'cache_creation_tokens') ?? 0;
                const cacheReadTokens = getNumericAttr(attrs, 'cache_read_tokens') ?? 0;
                const stopReason = getAttr(attrs, 'stop_reason') ?? null;
                const cwd = getAttr(attrs, 'cwd') ?? null;
                const gitBranch = getAttr(attrs, 'git_branch') ?? null;
                // Phase 2 enrichment: skill/agent/query-source/effort attribution
                // (dropped until now). Lets us attribute spend+output to the skill or
                // subagent that drove the turn, and measure main-vs-subagent autonomy.
                const querySource = getAttr(attrs, 'query_source') ?? null;
                const agentName = getAttr(attrs, 'agent.name') ?? null;
                const skillName = getAttr(attrs, 'skill.name') ?? null;
                const effort = getAttr(attrs, 'effort') ?? null;
                // One row per MODEL CALL, not per prompt: a prompt makes several
                // calls (~4 on average), each with its own request_id. Keying on
                // prompt.id kept the first and dropped the rest — Code spend read
                // at roughly a quarter of the true figure.
                const metaId = getAttr(attrs, 'request_id') ?? getAttr(attrs, 'client_request_id') ?? eventKey;

                await tx.insert(schema.codeAssistantMeta).values({
                  id: metaId,
                  user_id: resolvedUserId,
                  session_id: sessionId,
                  prompt_id: promptId,
                  model,
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  cache_creation_tokens: cacheCreationTokens,
                  cache_read_tokens: cacheReadTokens,
                  stop_reason: stopReason,
                  tool_use_count: 0,
                  error_count: 0,
                  cwd,
                  git_branch: gitBranch,
                  query_source: querySource,
                  agent_name: agentName,
                  skill_name: skillName,
                  effort,
                  source: 'otel',
                  occurred_at: occurredAt,
                }).onConflictDoNothing();
                result.processed++;
                break;
              }

              case 'claude_code.tool_result': {
                const toolName = getAttr(attrs, 'tool_name') ?? 'unknown';
                const successStr = getAttr(attrs, 'success') ?? 'true';
                const success = successStr === 'true' || successStr === '1';
                const toolParamsStr = getAttr(attrs, 'tool_parameters');
                const toolParams = toolParamsStr
                  ? (() => { try { return JSON.parse(toolParamsStr); } catch { return null; } })()
                  : null;
                const mcpScope = getAttr(attrs, 'mcp_server_scope');
                const durationMs = getNumericAttr(attrs, 'duration_ms');

                // MCP connector tracking — same resolution logic as cowork-receiver.
                // Custom MCP servers send a readable name; Anthropic marketplace plugins send
                // a stable UUID resolved via MARKETPLACE_UUID_NAMES. Unknown UUIDs skipped.
                if (mcpScope) {
                  const rawName = toolParams?.mcp_server_name ?? mcpScope;
                  const mcpServerName = (rawName && !isUuid(rawName))
                    ? rawName
                    : (rawName ? MARKETPLACE_UUID_NAMES[rawName.toLowerCase()] ?? null : null);
                  if (mcpServerName && !['workspace', 'cowork', 'Claude_in_Chrome'].includes(mcpServerName)) {
                    await tx.insert(schema.coworkMcpInvocations).values({
                      id: uuidv4(),
                      user_id: resolvedUserId,
                      session_id: sessionId,
                      mcp_server: mcpServerName,
                      mcp_tool: toolParams?.mcp_tool_name ?? toolName,
                      success: success ? 1 : 0,
                      duration_ms: durationMs,
                      source: 'otel',
                      surface: 'code',
                      prompt_id: promptId,
                      occurred_at: occurredAt,
                    }).onConflictDoNothing();
                    // Auto-register connector in the skill library.
                    const isAnthropicMarketplace = rawName != null && isUuid(rawName) && MARKETPLACE_UUID_NAMES[rawName.toLowerCase()] != null;
                    const nowSec = Math.floor(Date.now() / 1000);
                    if (isAnthropicMarketplace) {
                      await tx.insert(schema.skillLibraryEntries).values({
                        name: mcpServerName, type: 'connector', surface: 'code',
                        source: 'anthropic', is_published: 1, created_at: nowSec, updated_at: nowSec,
                      }).onConflictDoUpdate({
                        target: schema.skillLibraryEntries.name,
                        set: { source: 'anthropic', is_published: 1, updated_at: sql`excluded.updated_at` },
                      });
                    } else {
                      await tx.insert(schema.skillLibraryEntries).values({
                        name: mcpServerName, type: 'connector', surface: 'code',
                        source: 'org', is_published: 0, created_at: nowSec, updated_at: nowSec,
                      }).onConflictDoNothing();
                    }
                    result.processed++;
                  }
                }

                if (!success) {
                  // Friction row: model='' acts as a sentinel (aggregator filters on model != '')
                  // INSERT OR IGNORE to be idempotent — at-least-once OTel delivery may resend.
                  // Its own id: keyed on prompt.id it collided with the prompt's
                  // model-call row (same primary key) and was silently dropped.
                  const frictionId = `err:${getAttr(attrs, 'tool_use_id') ?? eventKey}`;
                  await tx.insert(schema.codeAssistantMeta).values({
                    id: frictionId,
                    user_id: resolvedUserId,
                    session_id: sessionId,
                    prompt_id: promptId,
                    model: '',
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 0,
                    tool_use_count: 0,
                    error_count: 1,
                    source: 'otel',
                    occurred_at: occurredAt,
                  }).onConflictDoNothing();
                  result.processed++;
                } else {
                  // Success path: check for git commit signal.
                  // Only when tool is Bash and tool_parameters contains git_commit_id.
                  // Privacy: only the count is incremented — the git_commit_id SHA is never stored.
                  if (
                    toolName === 'Bash' &&
                    toolParams !== null &&
                    typeof toolParams === 'object' &&
                    'git_commit_id' in (toolParams as Record<string, unknown>)
                  ) {
                    // Increment commit_count on the api_request row for this session+prompt.
                    // The WHERE model != '' guard ensures we never increment a friction sentinel
                    // row. Raw sql WHERE keeps `prompt_id = ?` semantics (a NULL promptId
                    // matches nothing, NOT `IS NULL`).
                    await tx
                      .update(schema.codeAssistantMeta)
                      .set({ commit_count: sql`${schema.codeAssistantMeta.commit_count} + 1` })
                      .where(firstModelCallOfPrompt(sessionId, promptId));
                    // Note: no result.processed++ for commit increments — not a new row insert.
                  }
                  result.skipped++;
                }
                break;
              }

              case 'claude_code.skill_activated': {
                // skill_activated goes to cowork_skill_invocations ONLY — no cowork_messages row.
                // Code CLI skills are registered in the shared skill library so the board shows counts.
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
                const invocationType = getAttr(attrs, 'invocation_type') ?? 'user_typed';

                await tx.insert(schema.coworkSkillInvocations).values({
                  id: uuidv4(),
                  user_id: resolvedUserId,
                  session_id: sessionId,
                  skill_name: skillName,
                  invocation_type: invocationType,
                  source: 'otel',
                  surface: 'code',
                  prompt_id: promptId,
                  occurred_at: occurredAt,
                });

                // Auto-register in the shared skill library so the board shows real counts.
                // Known Anthropic-bundled skills (docx, xlsx, ...) auto-publish — same
                // treatment as an Anthropic marketplace connector above — since there's no
                // real org owner to claim them; everything else lands unclaimed as usual.
                const nowSec = Math.floor(Date.now() / 1000);
                if (anthropicSkill) {
                  await tx.insert(schema.skillLibraryEntries).values({
                    name: skillName, type: 'skill', surface: 'code',
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
                    name: skillName, type: 'skill', surface: 'code',
                    source: 'org', is_published: 0, created_at: nowSec, updated_at: nowSec,
                  }).onConflictDoNothing();
                }

                result.processed++;
                break;
              }

              case 'claude_code.tool_decision': {
                // One event fires per tool use. Increment tool_use_count on the api_request
                // row so the autonomy ratio metric reflects actual tool usage.
                // Out-of-order delivery: if api_request hasn't arrived yet the UPDATE is a no-op.
                await tx
                  .update(schema.codeAssistantMeta)
                  .set({ tool_use_count: sql`${schema.codeAssistantMeta.tool_use_count} + 1` })
                  .where(firstModelCallOfPrompt(sessionId, promptId));
                result.skipped++;
                break;
              }

              default:
                // Unknown or non-Code event — skip silently
                result.skipped++;
                break;
            }
          });
          // Fire-and-forget — see the note in cowork-receiver.ts.
          // Fire-and-forget, so a failure cannot reach result.errors — it is
          // written to error_events instead. See lib/alerts/pii-alert-failure.ts
          // for why that matters and what it replaces.
          firePendingPiiAlert(resolvedUserId, pendingPiiAlert).catch((e: Error) => {
            console.error('[code-otel-receiver] pii alert error:', e.message);
            void recordPiiAlertFailure('code', pendingPiiAlert?.messageId, e);
          });
        } catch (e) {
          result.errors.push(`Event ${eventName}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}

export default processCodeOtlpLogs;

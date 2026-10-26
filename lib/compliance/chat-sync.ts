// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Compliance API chat sync — user prompts as text
// (PII/intent-flagged at ingest, alert-once on first insert), assistant
// replies as METADATA ONLY (chat_assistant_meta). LIVE-VERIFIED
// against the Enterprise tenant (real org-wide chats syncing clean).
import { sql, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { detectPii } from '@/lib/pii/detect';
import { createPiiAlerts } from '@/lib/alerts/pii-alerts';
import { detectIntent } from '@/lib/intent/detect';
import { createIntentAlerts } from '@/lib/alerts/intent-alerts';
import { getCustomCategories } from '@/lib/intent/custom';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { getChatMessages, listChats, ComplianceApiError, type ComplianceChatSummary, type ComplianceChatMessage, type ComplianceTextBlock, type ComplianceToolUseBlock } from './client';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

// System connector names that are infrastructure-level, not named
// integrations — mirrors lib/otel/cowork-receiver.ts's exclusion list.
// Invocation rows are still written for these (usage is still real), but
// they never get an S&C Board library entry.
const SYSTEM_CONNECTOR_NAMES = new Set(['workspace', 'cowork', 'Claude_in_Chrome']);

// Claude.ai's OWN built-in tool families, as they appear in the Compliance
// API export. The July design assumed a built-in tool carried no
// `integration_name`; the first real tenant sync
// showed that Anthropic labels its built-in tool calls with a
// family name too — "File Creation" (bash_tool / create_file / view /
// present_files), "Dynamic Widget" (ask_user_input_v0), and on localhost's
// own synced history "Web Fetch" and "Tool Search" too. Those are not
// connectors: recording them wrote one "Connector Used" row per tool call
// and put "File Creation" on the S&C Board as an unclaimed connector. A real
// connector's integration_name can also contain spaces ("Google Drive" was
// observed alongside), so this is a denylist, not a shape heuristic. Names
// compared case-insensitively. Extend when a new family is observed.
const BUILT_IN_TOOL_FAMILIES = new Set(['file creation', 'dynamic widget', 'web fetch', 'tool search']);

export function isBuiltInToolFamily(integrationName: string | null | undefined): boolean {
  return !!integrationName && BUILT_IN_TOOL_FAMILIES.has(integrationName.trim().toLowerCase());
}

/**
 * Extract named connector invocations from a single chat message's tool_use
 * blocks. Runs for BOTH user and assistant
 * messages — assistant messages are the ones that actually carry tool_use.
 * A bare tool_use with neither `integration_name` nor `mcp_server_url` is a
 * built-in tool (e.g. bash), not a connector call — skipped entirely. So is
 * a tool_use whose `integration_name` is one of Claude.ai's own built-in
 * tool families (BUILT_IN_TOOL_FAMILIES above).
 * `block.input` is NEVER read (may contain arbitrary content).
 * Returns the number of qualifying tool_use blocks processed (not the
 * number of NEW rows — mirrors assistantMeta's count-per-message-processed
 * convention, so a re-sync still reports the blocks it saw even though the
 * unique dedup index makes the actual inserts a no-op).
 */
async function extractConnectorInvocations(
  tx: TypedClient,
  msg: ComplianceChatMessage,
  sessionId: string,
  userId: string,
  occurredAt: number,
  nowS: number,
): Promise<number> {
  let count = 0;
  for (const block of msg.content || []) {
    if (block.type !== 'tool_use') continue;
    const tu = block as ComplianceToolUseBlock;
    if (isBuiltInToolFamily(tu.integration_name)) continue; // Claude.ai built-in tool, not a connector

    let mcpServer: string | null = tu.integration_name ?? null;
    if (!mcpServer) {
      if (!tu.mcp_server_url) continue; // bare tool_use — built-in tool, skip
      try {
        mcpServer = new URL(tu.mcp_server_url).host;
      } catch {
        continue; // unparseable URL and no integration_name — skip
      }
      if (!mcpServer) continue;
    }
    const mcpTool = tu.name ?? 'unknown';

    await tx.insert(schema.coworkMcpInvocations).values({
      id: uuidv4(), user_id: userId, session_id: sessionId,
      mcp_server: mcpServer, mcp_tool: mcpTool,
      occurred_at: occurredAt, source: 'compliance', surface: 'chat', success: 1,
    }).onConflictDoNothing();
    count++;

    if (!SYSTEM_CONNECTOR_NAMES.has(mcpServer)) {
      await tx.insert(schema.skillLibraryEntries).values({
        name: mcpServer, type: 'connector', surface: 'chat',
        source: 'org', is_published: 0, created_at: nowS, updated_at: nowS,
      }).onConflictDoNothing();
    }
  }
  return count;
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local.split(/[._-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/** Resolve a CCC user id by email; create users + admin_users
 *  (sentinel) rows when unseen. The admin_users sentinel enrolment
 *  (password_hash '__otel_pending__', role 'pulse') mirrors the OTel
 *  receiver, but the email MATCH here is deliberately case-insensitive —
 *  the OTel receiver's match is exact. */
export async function resolveUserByEmail(client: TypedClient, email: string, fallbackId: string, nowS: number): Promise<string> {
  const existing = await client
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = lower(${email})`)
    .limit(1);
  if (existing[0]) {
    await client.update(schema.users).set({ last_seen_at: nowS }).where(eq(schema.users.id, existing[0].id));
    return existing[0].id;
  }
  await client.insert(schema.users).values({
    id: fallbackId, email, display_name: displayNameFromEmail(email),
    source: 'compliance', first_seen_at: nowS, last_seen_at: nowS,
  }).onConflictDoNothing();
  const adminRows = await client
    .select({ id: schema.adminUsers.id }).from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, email.toLowerCase())).limit(1);
  if (!adminRows[0]) {
    await client.insert(schema.adminUsers).values({
      id: fallbackId, email: email.toLowerCase(), password_hash: '__otel_pending__',
      display_name: displayNameFromEmail(email), role: 'pulse',
      linked_cowork_user_id: fallbackId, sso_enabled: 0,
    }).onConflictDoNothing();
  }
  return fallbackId;
}

function textOf(msg: ComplianceChatMessage): string {
  return (msg.content || [])
    .filter((b): b is ComplianceTextBlock => b.type === 'text')
    .map(b => b.text)
    .filter((t): t is string => !!t)
    .join('\n');
}

export async function syncChat(
  client: TypedClient,
  apiKey: string,
  chat: ComplianceChatSummary,
  minOccurredAtS: number,
): Promise<{ prompts: number; assistantMeta: number; connectors: number }> {
  const nowS = Math.floor(Date.now() / 1000);
  const userId = await resolveUserByEmail(client, chat.user.email_address, chat.user.id, nowS);
  const customCategories = await getCustomCategories();

  let prompts = 0;
  let assistantMeta = 0;
  let connectors = 0;
  const pendingPiiAlerts: Array<{ flagReason: string; messageId: string; text: string }> = [];
  const pendingIntentAlerts: Array<{ messageId: string; text: string; matches: import('@/lib/intent/types').IntentMatch[] }> = [];

  let afterId: string | undefined;
  let hasMore = true;
  // Retention floor sent to the API as well as enforced below. Without the
  // bound, a chat that gains one message makes us re-page its ENTIRE history
  // (100 per request, every run) only to drop everything pre-floor. The
  // client-side check stays as belt and braces: it is the guarantee, the
  // bound is the saving.
  const createdAtGte = new Date(minOccurredAtS * 1000).toISOString();
  while (hasMore) {
    const page = await getChatMessages(apiKey, chat.id, { afterId, limit: 100, createdAtGte });

    await withTx(client, async (tx) => {
      for (const msg of page.chat_messages) {
        const occurredAt = Math.floor(new Date(msg.created_at).getTime() / 1000);
        if (!Number.isFinite(occurredAt) || occurredAt < minOccurredAtS) continue; // backfill/retention floor

        // Connector extraction runs for EVERY message (user AND assistant) —
        // assistant messages are the ones that actually carry tool_use blocks.
        // Deliberately OUTSIDE/BEFORE the role branching and the prompt
        // exists-gate below: assistant messages have no prompt row at all,
        // and a re-synced user message would otherwise never re-reach this
        // extraction if it were placed after the exists-gate's `continue`.
        // Idempotent via cowork_mcp_invocations' unique dedup index.
        connectors += await extractConnectorInvocations(tx, msg, chat.id, userId, occurredAt, nowS);

        if (msg.role === 'assistant') {
          await tx.insert(schema.chatAssistantMeta).values({
            id: msg.id, conversation_id: chat.id, user_id: userId,
            model: chat.model, // chat-level field — approximate per-message
            artifacts_count: (msg.artifacts || []).length,
            generated_files_count: (msg.generated_files || []).length,
            occurred_at: occurredAt, ingested_at: nowS,
          }).onConflictDoNothing();
          assistantMeta++;
          continue;
        }
        if (msg.role !== 'user') continue;

        const promptText = textOf(msg);
        if (!promptText) continue;

        // Alert-once gate: only flag + alert when the row is NEW.
        const exists = await tx.select({ one: sql<number>`1` }).from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, msg.id)).limit(1);
        if (exists.length > 0) continue;

        const piiHits = detectPii(promptText);
        const intentMatches = detectIntent(promptText, customCategories);
        const reasons: string[] = [];
        if (piiHits.length > 0) reasons.push(`PII detected: ${piiHits.join(', ')}`);
        if (intentMatches.length > 0) reasons.push(`Intent detected: ${intentMatches.map(m => m.categoryId).join(', ')}`);
        const flagReason = reasons.length > 0 ? reasons.join(' | ') : null;

        await tx.insert(schema.chatMessages).values({
          id: msg.id, conversation_id: chat.id, user_id: userId,
          prompt_text: promptText, prompt_length: promptText.length,
          attachments_count: (msg.files || []).length, files_count: (msg.files || []).length,
          flagged: flagReason ? 1 : 0, flag_reason: flagReason,
          occurred_at: occurredAt, agent_id: null, source: 'compliance',
        }).onConflictDoNothing();
        prompts++;

        if (piiHits.length > 0) pendingPiiAlerts.push({ flagReason: flagReason!, messageId: msg.id, text: promptText });
        if (intentMatches.length > 0) pendingIntentAlerts.push({ messageId: msg.id, text: promptText, matches: intentMatches });
      }
    });

    // Alerts after commit — flushed PER PAGE (not after the whole while-loop)
    // so a later page's failure can never discard an earlier, already-
    // committed page's alerts: the alert-once gate above keys on row
    // existence, so a lost in-memory alert would never fire again on retry.
    // Alerts only after that page's own commit.
    for (const p of pendingPiiAlerts) {
      await createPiiAlerts(userId, p.flagReason, 'chat', p.messageId, p.text);
    }
    for (const p of pendingIntentAlerts) {
      createIntentAlerts(userId, 'chat', p.messageId, p.text, p.matches).catch(() => { /* must not break sync */ });
    }
    pendingPiiAlerts.length = 0;
    pendingIntentAlerts.length = 0;

    hasMore = page.has_more && !!page.last_id;
    afterId = page.last_id ?? undefined;
  }

  return { prompts, assistantMeta, connectors };
}

/**
 * Run loop over listChats + syncChat: cursor discipline (updated_at.gte on
 * the first run, after_id thereafter), the backfill/retention window, and a
 * per-run cap. A page is only ever processed in full — if fully processing
 * it would exceed the cap, the whole page is skipped this run (re-listed
 * next run; syncChat's onConflictDoNothing makes that re-processing free).
 * Any failure other than a 404 (chat hard-deleted between list and fetch)
 * aborts the run immediately with the cursor left unadvanced, so the failed
 * chat is retried from the same point next run.
 */
export async function runChatSync(): Promise<{ chatsProcessed: number; prompts: number; assistantMeta: number; connectors: number; errors: string[] }> {
  const result = { chatsProcessed: 0, prompts: 0, assistantMeta: 0, connectors: 0, errors: [] as string[] };
  const apiKey = await getConfigValue('complianceAccessKey');
  if (!apiKey) return result;

  const client = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const backfillDays = parseInt(await getConfigValue('complianceBackfillDays') || '30', 10) || 30;
  const cap = parseInt(await getConfigValue('complianceChatsPerRun') || '200', 10) || 200;
  // Resurrection guard: retentionChatDays may be SHORTER than the backfill
  // window (e.g. backfill=30 but retention only keeps 7 days of chat
  // content) — without this, a later sync run would re-insert a message
  // that retention had already pruned, resurrecting deleted content. Take
  // the narrower (smaller-days) of the two floors. An unset/0/NaN
  // retentionChatDays leaves the floor at backfill-only (no retention
  // configured yet, or retention disabled for this table).
  const retentionChatDaysRaw = parseInt(await getConfigValue('retentionChatDays') || '', 10);
  const floorDays = (Number.isFinite(retentionChatDaysRaw) && retentionChatDaysRaw > 0)
    ? Math.min(backfillDays, retentionChatDaysRaw)
    : backfillDays;
  const minOccurredAtS = nowS - floorDays * 86400;
  let cursor = (await getConfigValue('complianceChatCursor')) || '';
  // Request pages no bigger than the cap so a cap smaller than the API's
  // default page size (100) still makes forward progress each run — see
  // the cap-check comment below for why an oversized page would otherwise
  // stall the sync forever.
  const limit = Math.min(100, cap);

  try {
    while (result.chatsProcessed < cap) {
      const page = cursor
        ? await listChats(apiKey, { afterId: cursor, limit })
        : await listChats(apiKey, { updatedAtGte: new Date(minOccurredAtS * 1000).toISOString(), limit });
      if (page.data.length === 0) break;

      // Cap check BEFORE processing: only advance the cursor past pages we
      // fully processed. A partially-capped page is re-listed next run.
      if (result.chatsProcessed + page.data.length > cap) break;

      for (const chat of page.data) {
        try {
          const r = await syncChat(client, apiKey, chat, minOccurredAtS);
          result.prompts += r.prompts;
          result.assistantMeta += r.assistantMeta;
          result.connectors += r.connectors;
          result.chatsProcessed++;
        } catch (err) {
          if (err instanceof ComplianceApiError && err.status === 404) {
            result.chatsProcessed++; // hard-deleted between list and fetch — legitimate skip
            continue;
          }
          // Any other failure: abort with cursor unadvanced so the chat is retried.
          result.errors.push(err instanceof Error ? err.message : String(err));
          return result;
        }
      }

      if (page.last_id) {
        cursor = page.last_id;
        await setConfigValue('complianceChatCursor', cursor);
      }
      if (!page.has_more) break;
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}

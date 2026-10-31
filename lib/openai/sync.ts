// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OpenAI sync: reads the ChatGPT and Codex export files and stores each
// person's prompts where the matching Claude prompts already live, so every
// page that reads them works unchanged:
//
//   ChatGPT Chat and Work user messages → cowork_messages, surface 'cowork',
//     message_type 'cowork_user_message', one session per conversation,
//     source 'chatgpt_chat' / 'chatgpt_work'
//   Codex PROMPT_SENT                    → cowork_messages, surface 'code',
//     message_type 'code_user_message', one session per Codex session,
//     source 'codex'
//
// Prompts are checked for personal data and risky intent exactly as the OTel
// receivers check Claude prompts, and alert once, on the first insert.
// Assistant replies, token counts and costs are later phases; reply TEXT is
// never stored.
//
// ChatGPT Work also appears in CODEX_LOG with a CODEX_WORK_* app, carrying the
// same prompt. Work is taken from CONVERSATION_MESSAGE only, so those Codex
// log records are skipped rather than stored twice.
//
// Files are walked oldest first per log type from a saved cursor (the last
// file's end_time). The cursor moves only after a file is fully stored, so a
// failure retries that file next run. Delivery is at least once: every row id
// is derived from OpenAI's own ids, so a repeated event is a no-op.
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { detectPiiWithMatches, type PiiMatch } from '@/lib/pii/detect';
import { detectIntent } from '@/lib/intent/detect';
import { getCustomCategories } from '@/lib/intent/custom';
import type { IntentMatch } from '@/lib/intent/types';
import { createIntentAlerts } from '@/lib/alerts/intent-alerts';
import { createPiiAlertsWithDedup } from '@/lib/alerts/pii-alerts';
import { recordPiiAlertFailure } from '@/lib/alerts/pii-alert-failure';
import { CONTENT_PREVIEW_CHARS, CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';
import { resolveOtelUser } from '@/lib/otel/resolve-user';
import { isPlainEmail } from '@/lib/email/address';
import { listLogFiles, downloadLogFile, parseJsonl, type LogScope, type OpenAiEventType } from './client';
import { OPENAI_SOURCE_LABELS, OPENAI_USER_SOURCE, type OpenAiSource } from './sources';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

/** Log types this phase reads, and where each is listed. */
export const SYNCED_TYPES: OpenAiEventType[] = ['CONVERSATION_MESSAGE', 'CODEX_LOG'];

/**
 * Downloads are paced so one run stays under OpenAI's 100 requests a minute
 * on the download route (~92 a minute), and capped per run so a first
 * backfill spreads over several runs instead of one very long one.
 */
export const MIN_DOWNLOAD_GAP_MS = 650;
export const DEFAULT_FILES_PER_RUN = 300;
/** OpenAI keeps export files for 30 days, so a first run never looks further back. */
export const MAX_BACKFILL_DAYS = 30;

export interface OpenAiSyncStats {
  files: number;
  records: number;
  prompts: Record<OpenAiSource, number>;
  /** Records already stored (OpenAI delivers at least once). */
  repeats: number;
  /** ChatGPT Work prompts seen again in the Codex log and skipped. */
  workInCodexLog: number;
  /** Records with no single plain email, so no person to attach them to. */
  noPerson: number;
  /** Records older than the backfill or retention window. */
  tooOld: number;
  badLines: number;
  errors: string[];
}

export function emptyStats(): OpenAiSyncStats {
  return {
    files: 0, records: 0, prompts: { chatgpt_chat: 0, chatgpt_work: 0, codex: 0 },
    repeats: 0, workInCodexLog: 0, noPerson: 0, tooOld: 0, badLines: 0, errors: [],
  };
}

// ── Record shapes (only the fields read) ────────────────────────────────────
interface Envelope {
  event_id?: string;
  type?: string;
  timestamp?: string;
  actor?: { type?: string; user_id?: string; user_email?: string };
}
interface ConversationMessageRecord extends Envelope {
  message?: {
    id?: string;
    created_at?: string;
    author?: { type?: string; client_type?: string; model?: string };
    content?: { type?: string; value?: string | null };
    files?: Array<{ id?: string; name?: string }>;
  };
  conversation?: { id?: string; mode?: string };
}
interface CodexLogRecord extends Envelope {
  event_type?: string;
  client_id?: string;
  event_details?: { session_id?: string; prompt_text?: string; model?: string };
}

/** A prompt ready to store, after every check that needs no database. */
export interface PromptRow {
  id: string;
  sessionId: string;
  source: OpenAiSource;
  surface: 'cowork' | 'code';
  messageType: 'cowork_user_message' | 'code_user_message';
  email: string;
  text: string;
  model: string | null;
  occurredAt: number;
  /** Names of files the person attached (ChatGPT only). */
  fileNames: string[];
}

export type Interpretation =
  | { kind: 'prompt'; row: PromptRow }
  | { kind: 'skip'; reason: 'not_a_prompt' | 'work_in_codex_log' | 'no_person' | 'too_old' };

function toSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Decides what one export record becomes. Pure, so every rule is testable on
 * its own: which records are prompts, which surface and source they take, and
 * the ids that make a repeated delivery a no-op.
 */
export function interpretRecord(raw: unknown, floors: { cowork: number; code: number }): Interpretation {
  const rec = raw as Envelope;
  if (!rec || typeof rec !== 'object') return { kind: 'skip', reason: 'not_a_prompt' };

  if (rec.type === 'CONVERSATION_MESSAGE') {
    const r = rec as ConversationMessageRecord;
    const m = r.message;
    if (m?.author?.type !== 'user' || m.content?.type !== 'text') return { kind: 'skip', reason: 'not_a_prompt' };
    const text = (m.content.value ?? '').trim();
    if (!text || !m.id || !r.conversation?.id) return { kind: 'skip', reason: 'not_a_prompt' };
    const email = r.actor?.user_email ?? '';
    if (!isPlainEmail(email)) return { kind: 'skip', reason: 'no_person' };
    const occurredAt = toSeconds(m.created_at) ?? toSeconds(r.timestamp);
    if (occurredAt === null) return { kind: 'skip', reason: 'not_a_prompt' };
    if (occurredAt < floors.cowork) return { kind: 'skip', reason: 'too_old' };
    const isWork = r.conversation.mode === 'work';
    return {
      kind: 'prompt',
      row: {
        // Keyed on OpenAI's message id: an edited message arrives as a new
        // event with the same message id and keeps the first version stored.
        id: `chatgpt:${m.id}`,
        sessionId: `chatgpt:${r.conversation.id}`,
        source: isWork ? 'chatgpt_work' : 'chatgpt_chat',
        surface: 'cowork',
        messageType: 'cowork_user_message',
        email,
        text,
        model: null,
        occurredAt,
        fileNames: (m.files ?? []).map(f => f.name).filter((n): n is string => !!n),
      },
    };
  }

  if (rec.type === 'CODEX_LOG') {
    const r = rec as CodexLogRecord;
    if (r.event_type !== 'PROMPT_SENT') return { kind: 'skip', reason: 'not_a_prompt' };
    if ((r.client_id ?? '').startsWith('CODEX_WORK_')) return { kind: 'skip', reason: 'work_in_codex_log' };
    const text = (r.event_details?.prompt_text ?? '').trim();
    const sessionId = r.event_details?.session_id;
    if (!text || !sessionId || !r.event_id) return { kind: 'skip', reason: 'not_a_prompt' };
    const email = r.actor?.user_email ?? '';
    if (!isPlainEmail(email)) return { kind: 'skip', reason: 'no_person' };
    const occurredAt = toSeconds(r.timestamp);
    if (occurredAt === null) return { kind: 'skip', reason: 'not_a_prompt' };
    if (occurredAt < floors.code) return { kind: 'skip', reason: 'too_old' };
    return {
      kind: 'prompt',
      row: {
        id: `codex:${r.event_id}`,
        sessionId: `codex:${sessionId}`,
        source: 'codex',
        surface: 'code',
        messageType: 'code_user_message',
        email,
        text,
        model: r.event_details?.model ?? null,
        occurredAt,
        fileNames: [],
      },
    };
  }

  return { kind: 'skip', reason: 'not_a_prompt' };
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local.split(/[._-]/).filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

interface PendingAlert {
  userId: string;
  source: OpenAiSource;
  surface: 'cowork' | 'code';
  messageId: string;
  text: string;
  pii: PiiMatch[];
  intent: IntentMatch[];
}

/**
 * Stores one file's records in a single transaction. Returns the alerts to
 * raise once it has committed, so no alert is ever raised for a row that was
 * rolled back.
 */
async function storeRecords(
  client: TypedClient,
  records: unknown[],
  floors: { cowork: number; code: number },
  stats: OpenAiSyncStats,
  userCache: Map<string, string>,
): Promise<PendingAlert[]> {
  const nowS = Math.floor(Date.now() / 1000);
  const customCategories = await getCustomCategories();
  const pending: PendingAlert[] = [];

  await withTx(client, async (tx) => {
    for (const raw of records) {
      stats.records++;
      const it = interpretRecord(raw, floors);
      if (it.kind === 'skip') {
        if (it.reason === 'work_in_codex_log') stats.workInCodexLog++;
        else if (it.reason === 'no_person') stats.noPerson++;
        else if (it.reason === 'too_old') stats.tooOld++;
        continue;
      }
      const row = it.row;

      const key = row.email.trim().toLowerCase();
      let userId = userCache.get(key);
      if (!userId) {
        const resolved = await resolveOtelUser(tx, {
          email: row.email,
          installationId: null,
          displayName: displayNameFromEmail(row.email),
          department: null,
          surface: row.surface,
          nowS,
          eventCount: 1,
          userSource: OPENAI_USER_SOURCE,
        });
        userId = resolved.userId;
        userCache.set(key, userId);
      }

      const piiMatches = detectPiiWithMatches(row.text);
      const intentMatches = detectIntent(row.text, customCategories);
      const reasons: string[] = [];
      if (piiMatches.length > 0) reasons.push(`PII detected: ${piiMatches.map(m => m.type).join(', ')}`);
      if (intentMatches.length > 0) reasons.push(`Intent detected: ${intentMatches.map(m => m.categoryId).join(', ')}`);
      const flagReason = reasons.length > 0 ? reasons.join(' | ') : null;

      const inserted = await tx.insert(schema.coworkMessages).values({
        id: row.id,
        session_id: row.sessionId,
        user_id: userId,
        message_type: row.messageType,
        surface: row.surface,
        source: row.source,
        model: row.model,
        content_preview: row.text.slice(0, CONTENT_PREVIEW_CHARS),
        content_full: row.text.slice(0, CONTENT_FULL_CHARS),
        flagged: flagReason ? 1 : 0,
        flag_reason: flagReason,
        occurred_at: row.occurredAt,
      }).onConflictDoNothing().returning({ id: schema.coworkMessages.id });

      if (inserted.length === 0) { stats.repeats++; continue; }
      stats.prompts[row.source]++;

      if (row.surface === 'cowork') {
        // One Cowork session per ChatGPT conversation, as the OTel receiver
        // keeps one per Cowork session; attached file names join its uploads.
        await tx.insert(schema.coworkSessions).values({
          id: row.sessionId,
          conversation_id: row.sessionId,
          user_id: userId,
          source: row.source,
          started_at: row.occurredAt,
          created_at: nowS,
        }).onConflictDoNothing();
        await tx.update(schema.coworkSessions)
          .set({ started_at: sql`LEAST(COALESCE(${schema.coworkSessions.started_at}, ${row.occurredAt}), ${row.occurredAt})` })
          .where(eq(schema.coworkSessions.id, row.sessionId));
        if (row.fileNames.length > 0) {
          const current = (await tx.select({ files: schema.coworkSessions.files_uploaded })
            .from(schema.coworkSessions).where(eq(schema.coworkSessions.id, row.sessionId)).limit(1))[0];
          let existing: string[] = [];
          try { existing = current?.files ? JSON.parse(current.files) : []; } catch { existing = []; }
          const merged = Array.from(new Set([...existing, ...row.fileNames]));
          await tx.update(schema.coworkSessions)
            .set({ files_uploaded: JSON.stringify(merged) })
            .where(eq(schema.coworkSessions.id, row.sessionId));
        }
      }

      if (piiMatches.length > 0 || intentMatches.length > 0) {
        pending.push({ userId, source: row.source, surface: row.surface, messageId: row.id, text: row.text, pii: piiMatches, intent: intentMatches });
      }
    }
  });

  return pending;
}

/** Same as the OTel receivers: never awaited inside the sync, never lost silently. */
function raiseAlerts(alerts: PendingAlert[]): void {
  for (const a of alerts) {
    if (a.pii.length > 0) {
      createPiiAlertsWithDedup(a.userId, a.pii, a.text, a.messageId, a.surface, `${OPENAI_SOURCE_LABELS[a.source]} (OpenAI export)`).catch((e: Error) => {
        console.error('[openai-sync] pii alert error:', e.message);
        void recordPiiAlertFailure(a.surface, a.messageId, e);
      });
    }
    if (a.intent.length > 0) {
      createIntentAlerts(a.userId, a.surface, a.messageId, a.text, a.intent).catch((e: Error) => {
        console.error('[openai-sync] intent alert error:', e.message);
      });
    }
  }
}

function readCursors(raw: string): Partial<Record<OpenAiEventType, string>> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const daysSetting = (raw: string, fallback: number): number => {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface RunOptions {
  /** Gap between downloads; tests pass 0. */
  downloadGapMs?: number;
  filesPerRun?: number;
}

/**
 * One sync run over every log type in SYNCED_TYPES. Each type walks forward
 * from its own cursor; a failure stops that type for this run with its cursor
 * where it was, and the next type still runs.
 */
export async function runOpenAiSync(opts: RunOptions = {}): Promise<OpenAiSyncStats> {
  const stats = emptyStats();
  const apiKey = await getConfigValue('openaiAdminApiKey');
  const workspaceId = (await getConfigValue('openaiWorkspaceId')).trim();
  if (!apiKey || !workspaceId) return stats;

  const client = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const backfillDays = Math.min(daysSetting(await getConfigValue('openaiBackfillDays'), MAX_BACKFILL_DAYS), MAX_BACKFILL_DAYS);
  // Never bring back what retention has already deleted: the floor is the
  // narrower of the backfill window and each surface's retention window.
  const coworkRetention = daysSetting(await getConfigValue('retentionCoworkDays'), 90);
  const codeRetention = daysSetting(await getConfigValue('retentionCodeDays'), 90);
  const floors = {
    cowork: nowS - Math.min(backfillDays, coworkRetention) * 86400,
    code: nowS - Math.min(backfillDays, codeRetention) * 86400,
  };
  const firstAfter = new Date((nowS - backfillDays * 86400) * 1000).toISOString();
  const gap = opts.downloadGapMs ?? MIN_DOWNLOAD_GAP_MS;
  let budget = opts.filesPerRun ?? DEFAULT_FILES_PER_RUN;
  const cursors = readCursors(await getConfigValue('openaiSyncCursors'));
  const scope: LogScope = { kind: 'workspace', id: workspaceId };
  const userCache = new Map<string, string>();

  for (const [index, eventType] of SYNCED_TYPES.entries()) {
    // Each type gets a fair share of what is left, so a long backfill of one
    // log never holds the other back; a type that needs less leaves the rest
    // to the types after it.
    let share = Math.ceil(budget / (SYNCED_TYPES.length - index));
    let after = cursors[eventType] || firstAfter;
    try {
      while (share > 0) {
        const page = await listLogFiles(apiKey, scope, eventType, after, Math.min(100, share));
        if (page.data.length === 0) break;
        for (const file of page.data) {
          if (share <= 0) break;
          if (stats.files > 0 && gap > 0) await new Promise(r => setTimeout(r, gap));
          const text = await downloadLogFile(apiKey, scope, file.id);
          const { records, badLines } = parseJsonl(text);
          stats.badLines += badLines;
          const alerts = await storeRecords(client, records, floors, stats, userCache);
          stats.files++;
          budget--;
          share--;
          after = file.end_time;
          cursors[eventType] = after;
          await setConfigValue('openaiSyncCursors', JSON.stringify(cursors));
          raiseAlerts(alerts);
        }
        if (!page.has_more) break;
      }
    } catch (err) {
      stats.errors.push(`${eventType}: ${err instanceof Error ? err.message : String(err)}`);
      // A rolled-back file may have created people that no longer exist.
      userCache.clear();
    }
  }
  return stats;
}

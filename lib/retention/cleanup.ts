// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Follows the pattern in lib/db/queries.ts (esp. deleteUserData): reads
// via getTypedClient() + schema.<table>, the archive-then-delete batch via
// withTx (one atomic transaction — NOT savepointEach; a partial cleanup would
// leave content stripped/deleted from some tables but not others, which is
// exactly the all-or-nothing guarantee the original single `db.transaction`
// gave), row counts via the rowsAffected() helper.
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { getConfigValue, setConfigValue } from '@/lib/config';

// Postgres caps one statement at 65,535 bind parameters, so an id list handed
// to inArray() must be split. In strip mode cowork_messages rows are never
// deleted, so the "older than cutoff" id list grows with all history and
// can cross that cap.
export const RETENTION_ID_BATCH = 10_000;

export function chunkIds<T>(ids: T[], size = RETENTION_ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export interface CleanupResult {
  cowork_rows_affected: number;
  code_rows_affected: number;
  otel_rows_affected: number;
  compliance_rows_affected: number;
  error_rows_affected: number;
  chat_rows_affected: number;
  alerts_rows_affected: number;
  analytics_rows_affected: number;
  duration_ms: number;
  mode: 'strip' | 'purge';
  archived?: {
    cowork_rows: number;
    code_rows: number;
    otel_rows: number;
    compliance_rows: number;
    chat_rows: number;
    chat_meta_rows: number;
    error_rows: number;
    destination: string;
  };
  archive_error?: string;
}

export const STRIPPED_MARKER = '[Content removed — retention policy]';

/**
 * Affected-row count for UPDATE/DELETE (node-postgres resolves to
 * `.rowCount`, which can be null).
 */
function rowsAffected(result: unknown): number {
  const r = result as { rowCount?: number | null };
  return Number(r.rowCount ?? 0);
}

/**
 * Run retention cleanup across all content tables.
 * In 'strip' mode: nulls content columns, keeps metadata rows.
 * In 'purge' mode: deletes entire rows past retention.
 *
 * When archiveEnabled is true, rows are archived to cloud storage
 * BEFORE cleanup runs. Archive failure blocks cleanup (safety guarantee).
 */
export async function runRetentionCleanup(): Promise<CleanupResult> {
  const client = await getTypedClient();
  const start = Date.now();

  const mode = (await getConfigValue('retentionMode') || 'strip') as 'strip' | 'purge';
  const coworkDays = Math.max(7, parseInt(await getConfigValue('retentionCoworkDays') || '90', 10));
  const codeDays = Math.max(7, parseInt(await getConfigValue('retentionCodeDays') || '90', 10));
  const otelDays = Math.max(7, parseInt(await getConfigValue('retentionOtelDays') || '30', 10));
  const complianceDays = Math.max(7, parseInt(await getConfigValue('retentionComplianceDays') || '365', 10));
  const errorDays = Math.max(7, parseInt(await getConfigValue('retentionErrorDays') || '90', 10));
  const chatDays = Math.max(7, parseInt(await getConfigValue('retentionChatDays') || '90', 10));
  const alertsDays = Math.max(7, parseInt(await getConfigValue('retentionAlertsDays') || '90', 10));
  const analyticsDays = Math.max(7, parseInt(await getConfigValue('retentionAnalyticsDays') || '365', 10));

  // Calculate cutoffs OUTSIDE the transaction (needed by archive step)
  const nowSeconds = Math.floor(Date.now() / 1000);
  const coworkCutoff = nowSeconds - (coworkDays * 86400);
  const codeCutoff = nowSeconds - (codeDays * 86400);
  const otelCutoff = nowSeconds - (otelDays * 86400);
  const complianceCutoff = nowSeconds - (complianceDays * 86400);
  const errorCutoff = nowSeconds - (errorDays * 86400);
  const chatCutoff = nowSeconds - (chatDays * 86400);
  const alertsCutoff = nowSeconds - (alertsDays * 86400);
  // analytics_snapshots.snapshot_date is TEXT 'YYYY-MM-DD' — compute a
  // DATE-STRING cutoff, never compare it against an epoch integer.
  const analyticsCutoffDate = new Date((nowSeconds - analyticsDays * 86400) * 1000).toISOString().slice(0, 10);
  // github_repo_stats.date / github_user_repo_stats.date are ALSO TEXT
  // 'YYYY-MM-DD' (same trap as analytics_snapshots above) -- derive a
  // DATE-STRING cutoff from codeCutoff (they ride the Code-surface window),
  // never compare them against an epoch integer.
  const codeCutoffDate = new Date(codeCutoff * 1000).toISOString().slice(0, 10);

  let coworkAffected = 0;
  let codeAffected = 0;
  let otelAffected = 0;
  let complianceAffected = 0;
  let errorAffected = 0;
  let chatAffected = 0;
  let chatMetaAffected = 0;
  let codeMetricsAffected = 0;
  let alertsAffected = 0;
  let analyticsAffected = 0;
  let archiveResult: CleanupResult['archived'] | undefined;

  // ── Archive step (runs BEFORE cleanup) ──────────────────────────────
  const archiveEnabled = await getConfigValue('archiveEnabled') === 'true';
  if (archiveEnabled) {
    try {
      const { createProvider } = await import('@/lib/archive/factory');
      const { serializeToJsonlGzip, buildArchiveKey, buildManifest } = await import('@/lib/archive/serializer');
      const { insertErrorEvents } = await import('@/lib/db/error-queries');

      const providerConfig = {
        provider: await getConfigValue('archiveProvider') as 's3',
        bucket: await getConfigValue('archiveBucket'),
        region: await getConfigValue('archiveRegion'),
        accessKeyId: await getConfigValue('archiveAccessKeyId'),
        secretAccessKey: await getConfigValue('archiveSecretAccessKey'),
      };

      const provider = await createProvider(providerConfig);

      // Query rows to archive (same WHERE as cleanup). cowork_messages is
      // split by surface (each surface ages out on its OWN window) — without
      // this split, code-surface rows older than codeCutoff but younger than
      // coworkCutoff would be purged with NO archive copy whenever
      // codeDays < coworkDays (a real data-loss gap closed here).
      const coworkRows = await client.select().from(schema.coworkMessages).where(and(lt(schema.coworkMessages.occurred_at, coworkCutoff), or(eq(schema.coworkMessages.surface, 'cowork'), isNull(schema.coworkMessages.surface)))) as { occurred_at: number; [key: string]: unknown }[];
      const codeRows = await client.select().from(schema.coworkMessages).where(and(lt(schema.coworkMessages.occurred_at, codeCutoff), eq(schema.coworkMessages.surface, 'code'))) as { occurred_at: number; [key: string]: unknown }[];
      const otelRows = await client.select().from(schema.otelEvents).where(lt(schema.otelEvents.occurred_at, otelCutoff)) as { occurred_at: number; [key: string]: unknown }[];
      const complianceRows = await client.select().from(schema.complianceEvents).where(lt(schema.complianceEvents.occurred_at, complianceCutoff)) as { occurred_at: number; [key: string]: unknown }[];
      const chatRows = await client.select().from(schema.chatMessages).where(lt(schema.chatMessages.occurred_at, chatCutoff)) as { occurred_at: number; [key: string]: unknown }[];
      const chatMetaRows = await client.select().from(schema.chatAssistantMeta).where(lt(schema.chatAssistantMeta.occurred_at, chatCutoff)) as { occurred_at: number; [key: string]: unknown }[];
      const errorRows = await client.select().from(schema.errorEvents).where(lt(schema.errorEvents.occurred_at, errorCutoff)) as { occurred_at: number; [key: string]: unknown }[];

      const tableResults: Record<string, { rows: number; file: string | null }> = {};

      for (const [name, rows, cutoff] of [
        ['cowork_messages', coworkRows, coworkCutoff],
        ['cowork_messages_code', codeRows, codeCutoff],
        ['otel_events', otelRows, otelCutoff],
        ['compliance_events', complianceRows, complianceCutoff],
        ['chat_messages', chatRows, chatCutoff],
        ['chat_assistant_meta', chatMetaRows, chatCutoff],
        ['error_events', errorRows, errorCutoff],
      ] as [string, { occurred_at: number; [key: string]: unknown }[], number][]) {
        if (rows.length > 0) {
          const key = buildArchiveKey(name, rows, cutoff);
          const data = serializeToJsonlGzip(name, rows);
          await provider.upload(key, data);
          tableResults[name] = { rows: rows.length, file: key };
        } else {
          tableResults[name] = { rows: 0, file: null };
        }
      }

      // Upload manifest
      const manifest = buildManifest(
        mode,
        {
          cowork_days: coworkDays,
          code_days: codeDays,
          otel_days: otelDays,
          compliance_days: complianceDays,
          chat_days: chatDays,
          error_days: errorDays,
        },
        tableResults,
        '0.1.0'
      );
      const manifestKey = `ccc-archive/manifests/${new Date().toISOString().replace(/[:.]/g, '-')}_manifest.json`;
      await provider.upload(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)));

      archiveResult = {
        cowork_rows: coworkRows.length,
        code_rows: codeRows.length,
        otel_rows: otelRows.length,
        compliance_rows: complianceRows.length,
        chat_rows: chatRows.length,
        chat_meta_rows: chatMetaRows.length,
        error_rows: errorRows.length,
        destination: `${providerConfig.provider}://${providerConfig.bucket}/ccc-archive/`,
      };

      await insertErrorEvents([{
        severity: 'info',
        source: 'archive',
        message: `Archived ${coworkRows.length} cowork, ${codeRows.length} code, ${otelRows.length} otel, ${complianceRows.length} compliance, ${chatRows.length} chat, ${chatMetaRows.length} chat_meta, ${errorRows.length} error rows`,
        context_json: JSON.stringify(tableResults),
      }]);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Try to log the error (may fail if error-queries not available yet)
      try {
        const { insertErrorEvents } = await import('@/lib/db/error-queries');
        await insertErrorEvents([{
          severity: 'error',
          source: 'archive',
          message: `Archive failed: ${message}`,
          stack_trace: err instanceof Error ? err.stack ?? null : null,
        }]);
      } catch { /* can't log, proceed with error return */ }

      // CRITICAL: Archive failure blocks cleanup
      return {
        cowork_rows_affected: 0,
        code_rows_affected: 0,
        otel_rows_affected: 0,
        compliance_rows_affected: 0,
        error_rows_affected: 0,
        chat_rows_affected: 0,
        alerts_rows_affected: 0,
        analytics_rows_affected: 0,
        duration_ms: Date.now() - start,
        mode,
        archive_error: message,
      };
    }
  }

  // ── Cleanup step (same as before but uses pre-calculated cutoffs) ────
  // One atomic batch via withTx — preserves the original single
  // `db.transaction(...)`'s all-or-nothing guarantee (NOT savepointEach;
  // a partially-applied cleanup would leave some tables stripped/purged and
  // others untouched, which is not an acceptable outcome for retention).
  await withTx(client, async (tx) => {
    // Delete pulse children (FK -> cowork_messages.id) for a surface+cutoff
    // BEFORE the parent messages are touched. Runs in BOTH modes (pulse
    // tables are metadata-only, so their own retention tracks the same
    // per-surface age window regardless of whether the parent message's
    // content is stripped or purged). Selects the candidate ids first
    // (rather than an inArray(...) subquery), and guards the empty case so
    // an empty IN(...) is never issued. Plain unwrapped deletes (NOT savepointEach) — a failure
    // here must abort the whole retention transaction, per the module-level
    // all-or-nothing guarantee above.
    async function purgePulseChildren(surface: string, cutoff: number) {
      // 'cowork' also sweeps NULL-surface rows (same fold as the cowork
      // strip/purge blocks below) so their pulse children are deleted before
      // the parent message, preserving FK order; 'code' stays a strict match.
      const surfaceMatch = surface === 'cowork'
        ? or(eq(schema.coworkMessages.surface, 'cowork'), isNull(schema.coworkMessages.surface))
        : eq(schema.coworkMessages.surface, surface);
      const oldRows = await tx.select({ id: schema.coworkMessages.id }).from(schema.coworkMessages)
        .where(and(lt(schema.coworkMessages.occurred_at, cutoff), surfaceMatch));
      const oldIds = oldRows.map((r) => r.id);
      if (oldIds.length === 0) return;

      for (const batch of chunkIds(oldIds)) {
        await tx.delete(schema.pulseSkillRuns).where(inArray(schema.pulseSkillRuns.cowork_message_id, batch));
        await tx.delete(schema.pulseEvents).where(inArray(schema.pulseEvents.cowork_message_id, batch));
        await tx.delete(schema.pulseClassifications).where(inArray(schema.pulseClassifications.cowork_message_id, batch));
      }
    }

    await purgePulseChildren('cowork', coworkCutoff);
    await purgePulseChildren('code', codeCutoff);

    // Session descriptions are model-written from the session's prompts, so
    // they go with those prompts in BOTH modes, on the Cowork window
    // (occurred_at = the session's latest prompt; migration 0028).
    await tx.delete(schema.coworkSessionDescriptions)
      .where(lt(schema.coworkSessionDescriptions.occurred_at, coworkCutoff));

    // Use case session judgements carry a model-written reason about the
    // session's prompts, so they go with those prompts in BOTH modes, each on
    // its own surface's window (last_event_at = the session's last event when
    // judged; migration 0032). The weekly matches they wrote stay: those are
    // counts, kept on the 400-day weekly window like every other week row.
    const j = schema.useCaseSessionJudgements;
    await tx.delete(j).where(and(eq(j.surface, 'cowork'), lt(j.last_event_at, coworkCutoff)));
    await tx.delete(j).where(and(eq(j.surface, 'code'), lt(j.last_event_at, codeCutoff)));

    if (mode === 'strip') {
      // cowork_messages — strip content columns (surface='cowork' only; the
      // 'code' surface has its own window/block below).
      const coworkResult = await tx.update(schema.coworkMessages)
        .set({
          content_full: null,
          content_preview: STRIPPED_MARKER,
          tool_input_preview: null,
          tool_output_preview: null,
          // Model-authored prose about a PII match. It is scrubbed before
          // storage, but it describes the matched content, so it goes with
          // the content it describes rather than outliving it.
          pii_verdict_reason: null,
          // An output's file name is content-derived too (migration 0028).
          output_name: null,
        })
        .where(and(
          lt(schema.coworkMessages.occurred_at, coworkCutoff),
          or(eq(schema.coworkMessages.surface, 'cowork'), isNull(schema.coworkMessages.surface)),
          or(isNull(schema.coworkMessages.content_preview), ne(schema.coworkMessages.content_preview, STRIPPED_MARKER)),
        ));
      coworkAffected = rowsAffected(coworkResult);

      // code prompts — same strip, own window (retentionCodeDays).
      const codeResult = await tx.update(schema.coworkMessages)
        .set({
          content_full: null,
          content_preview: STRIPPED_MARKER,
          tool_input_preview: null,
          tool_output_preview: null,
          // Model-authored prose about a PII match. It is scrubbed before
          // storage, but it describes the matched content, so it goes with
          // the content it describes rather than outliving it.
          pii_verdict_reason: null,
          // An output's file name is content-derived too (migration 0028).
          output_name: null,
        })
        .where(and(
          lt(schema.coworkMessages.occurred_at, codeCutoff),
          eq(schema.coworkMessages.surface, 'code'),
          or(isNull(schema.coworkMessages.content_preview), ne(schema.coworkMessages.content_preview, STRIPPED_MARKER)),
        ));
      codeAffected = rowsAffected(codeResult);

      // otel_events — strip content columns (tool_input, file_paths)
      const otelResult = await tx.update(schema.otelEvents)
        .set({ tool_input: null, file_paths: null })
        .where(and(
          lt(schema.otelEvents.occurred_at, otelCutoff),
          or(isNotNull(schema.otelEvents.tool_input), isNotNull(schema.otelEvents.file_paths)),
        ));
      otelAffected = rowsAffected(otelResult);

      // compliance_events — strip content columns
      const complianceResult = await tx.update(schema.complianceEvents)
        .set({ content_preview: STRIPPED_MARKER, metadata: null })
        .where(and(
          lt(schema.complianceEvents.occurred_at, complianceCutoff),
          or(isNull(schema.complianceEvents.content_preview), ne(schema.complianceEvents.content_preview, STRIPPED_MARKER)),
        ));
      complianceAffected = rowsAffected(complianceResult);

      // error_events — strip content columns (stack_trace, context_json)
      const errorResult = await tx.update(schema.errorEvents)
        .set({ stack_trace: null, context_json: null })
        .where(and(
          lt(schema.errorEvents.occurred_at, errorCutoff),
          or(isNotNull(schema.errorEvents.stack_trace), isNotNull(schema.errorEvents.context_json)),
        ));
      errorAffected = rowsAffected(errorResult);

      // chat_messages — strip content. prompt_text is NOT NULL (unlike
      // cowork's content_full), so it takes the SAME marker used for
      // cowork's content_preview rather than a null — the row/metadata
      // (prompt_length, flagged, occurred_at, etc.) stays untouched.
      const chatResult = await tx.update(schema.chatMessages)
        .set({ prompt_text: STRIPPED_MARKER })
        .where(and(
          lt(schema.chatMessages.occurred_at, chatCutoff),
          ne(schema.chatMessages.prompt_text, STRIPPED_MARKER),
        ));
      chatAffected = rowsAffected(chatResult);

      // chat_assistant_meta is metadata-only (no content column) — nothing
      // to strip; left entirely untouched in strip mode.

    } else {
      // purge mode — delete rows, each surface on its own window
      coworkAffected = rowsAffected(
        await tx.delete(schema.coworkMessages).where(and(lt(schema.coworkMessages.occurred_at, coworkCutoff), or(eq(schema.coworkMessages.surface, 'cowork'), isNull(schema.coworkMessages.surface))))
      );
      codeAffected = rowsAffected(
        await tx.delete(schema.coworkMessages).where(and(lt(schema.coworkMessages.occurred_at, codeCutoff), eq(schema.coworkMessages.surface, 'code')))
      );

      otelAffected = rowsAffected(
        await tx.delete(schema.otelEvents).where(lt(schema.otelEvents.occurred_at, otelCutoff))
      );

      complianceAffected = rowsAffected(
        await tx.delete(schema.complianceEvents).where(lt(schema.complianceEvents.occurred_at, complianceCutoff))
      );

      errorAffected = rowsAffected(
        await tx.delete(schema.errorEvents).where(lt(schema.errorEvents.occurred_at, errorCutoff))
      );

      chatAffected = rowsAffected(
        await tx.delete(schema.chatMessages).where(lt(schema.chatMessages.occurred_at, chatCutoff))
      );
    }

    // ── Code metadata (metadata-only -> delete past codeCutoff in BOTH
    // modes; no content column, nothing to strip). ──────────────────────
    codeAffected += rowsAffected(
      await tx.delete(schema.codeAssistantMeta).where(lt(schema.codeAssistantMeta.occurred_at, codeCutoff))
    );
    codeAffected += rowsAffected(
      await tx.delete(schema.codeOtelMetrics).where(lt(schema.codeOtelMetrics.occurred_at, codeCutoff))
    );
    // OTel "already processed" register (migration 084 / PG 0025): only needed
    // while a collector could still re-deliver a batch, which its queue bounds
    // to days. 7 days, fixed; a time-indexed delete, never an id list.
    await tx.delete(schema.otelIngestedEvents)
      .where(lt(schema.otelIngestedEvents.received_at, Math.floor(Date.now() / 1000) - 7 * 86400));
    // code_session_classifications FK -> code_session_stats.session_id:
    // delete the children of old sessions first, then the sessions. Selects
    // the candidate ids first (rather than an inArray(...) subquery), and
    // guards the empty case so an empty IN(...) is never issued — same idiom as purgePulseChildren above.
    const oldCodeSessionRows = await tx.select({ sid: schema.codeSessionStats.session_id })
      .from(schema.codeSessionStats).where(lt(schema.codeSessionStats.last_at, codeCutoff));
    const oldCodeSessionIds = oldCodeSessionRows.map((r) => r.sid);
    for (const batch of chunkIds(oldCodeSessionIds)) {
      codeAffected += rowsAffected(
        await tx.delete(schema.codeSessionClassifications).where(inArray(schema.codeSessionClassifications.session_id, batch))
      );
    }
    codeAffected += rowsAffected(
      await tx.delete(schema.codeSessionStats).where(lt(schema.codeSessionStats.last_at, codeCutoff))
    );

    // GitHub per-user/per-repo attribution overlay (metadata-only -- counts
    // only, no content column) -- delete past the Code-surface window in
    // BOTH modes, same as the other code metadata tables above. Both tables'
    // date columns are TEXT 'YYYY-MM-DD', so codeCutoffDate (a date STRING)
    // is used here, never codeCutoff (an epoch integer). github_identity_map
    // (admin-managed mapping config; erasure covers user deletion via
    // deleteUserData) and github_unmatched_authors (self-rewrites every sync)
    // are deliberately left untouched by retention.
    codeAffected += rowsAffected(
      await tx.delete(schema.githubRepoStats).where(lt(schema.githubRepoStats.date, codeCutoffDate))
    );
    codeAffected += rowsAffected(
      await tx.delete(schema.githubUserRepoStats).where(lt(schema.githubUserRepoStats.date, codeCutoffDate))
    );

    // ── Skill/connector usage by surface (metadata-only -> delete in BOTH
    // modes, each surface on its own matching window). ──────────────────
    codeAffected += rowsAffected(
      await tx.delete(schema.coworkSkillInvocations).where(and(eq(schema.coworkSkillInvocations.surface, 'code'), lt(schema.coworkSkillInvocations.occurred_at, codeCutoff)))
    );
    codeAffected += rowsAffected(
      await tx.delete(schema.coworkMcpInvocations).where(and(eq(schema.coworkMcpInvocations.surface, 'code'), lt(schema.coworkMcpInvocations.occurred_at, codeCutoff)))
    );
    coworkAffected += rowsAffected(
      await tx.delete(schema.coworkSkillInvocations).where(and(eq(schema.coworkSkillInvocations.surface, 'cowork'), lt(schema.coworkSkillInvocations.occurred_at, coworkCutoff)))
    );
    coworkAffected += rowsAffected(
      await tx.delete(schema.coworkMcpInvocations).where(and(eq(schema.coworkMcpInvocations.surface, 'cowork'), lt(schema.coworkMcpInvocations.occurred_at, coworkCutoff)))
    );
    chatAffected += rowsAffected(
      await tx.delete(schema.coworkSkillInvocations).where(and(eq(schema.coworkSkillInvocations.surface, 'chat'), lt(schema.coworkSkillInvocations.occurred_at, chatCutoff)))
    );
    chatAffected += rowsAffected(
      await tx.delete(schema.coworkMcpInvocations).where(and(eq(schema.coworkMcpInvocations.surface, 'chat'), lt(schema.coworkMcpInvocations.occurred_at, chatCutoff)))
    );

    // ── chat_assistant_meta (metadata-only -> delete in BOTH modes; was
    // purge-only before — moved out of the mode branch above so it is no
    // longer duplicated/double-counted). ────────────────────────────────
    chatMetaAffected += rowsAffected(
      await tx.delete(schema.chatAssistantMeta).where(lt(schema.chatAssistantMeta.occurred_at, chatCutoff))
    );

    // Derived metric snapshots: rolling rows are only read over ~30 days
    // (week-over-week comparisons), so prune them in BOTH modes; weekly
    // trend rows are the long-term history — keep 400 days.
    const rollingCutoff = nowSeconds - (30 * 86400);
    const weeklyCutoff = nowSeconds - (400 * 86400);

    const codeMetricsRollingDeleted = rowsAffected(
      await tx.delete(schema.codeMetrics).where(and(eq(schema.codeMetrics.granularity, 'rolling'), lt(schema.codeMetrics.computed_at, rollingCutoff)))
    );
    const codeMetricsWeeklyDeleted = rowsAffected(
      await tx.delete(schema.codeMetrics).where(and(eq(schema.codeMetrics.granularity, 'week'), lt(schema.codeMetrics.computed_at, weeklyCutoff)))
    );
    // Safety net: a metric row dated in the FUTURE is always corrupt (only a
    // buggy seed produces one) and it poisons every "latest row" tile, which
    // picks MAX(computed_at) — the future row wins and reads zero. Prune them.
    const codeMetricsFutureDeleted = rowsAffected(
      await tx.delete(schema.codeMetrics).where(gt(schema.codeMetrics.computed_at, nowSeconds))
    );
    codeMetricsAffected += codeMetricsRollingDeleted + codeMetricsWeeklyDeleted + codeMetricsFutureDeleted;

    const pulseMetricsRollingDeleted = rowsAffected(
      await tx.delete(schema.pulseMetrics).where(and(eq(schema.pulseMetrics.granularity, 'rolling'), lt(schema.pulseMetrics.computed_at, rollingCutoff)))
    );
    const pulseMetricsWeeklyDeleted = rowsAffected(
      await tx.delete(schema.pulseMetrics).where(and(eq(schema.pulseMetrics.granularity, 'week'), lt(schema.pulseMetrics.computed_at, weeklyCutoff)))
    );
    const pulseMetricsFutureDeleted = rowsAffected(
      await tx.delete(schema.pulseMetrics).where(gt(schema.pulseMetrics.computed_at, nowSeconds))
    );
    codeMetricsAffected += pulseMetricsRollingDeleted + pulseMetricsWeeklyDeleted + pulseMetricsFutureDeleted;

    // Use-case tracking history — weekly rows + junction, same 400-day horizon.
    // week_start is epoch SECONDS (matches weeklyCutoff, also in seconds).
    const useCaseWeeksDeleted = rowsAffected(
      await tx.delete(schema.useCaseActivationWeeks).where(lt(schema.useCaseActivationWeeks.week_start, weeklyCutoff))
    );
    codeMetricsAffected += useCaseWeeksDeleted;

    const useCaseMatchesDeleted = rowsAffected(
      await tx.delete(schema.useCaseWeekMatches).where(lt(schema.useCaseWeekMatches.week_start, weeklyCutoff))
    );
    codeMetricsAffected += useCaseMatchesDeleted;

    // ── Alerts: only resolved/dismissed age out; open/active alerts are
    // always kept regardless of age (both modes, metadata-only). ────────
    alertsAffected = rowsAffected(await tx.delete(schema.alerts).where(and(
      inArray(schema.alerts.status, ['resolved', 'dismissed']),
      lt(schema.alerts.generated_at, alertsCutoff),
    )));

    // ── Adoption analytics snapshots (both modes, metadata-only).
    // snapshot_date is a DATE STRING ('YYYY-MM-DD') — compared against
    // analyticsCutoffDate, never against an epoch integer. ───────────────
    analyticsAffected = rowsAffected(await tx.delete(schema.analyticsSnapshots).where(
      lt(schema.analyticsSnapshots.snapshot_date, analyticsCutoffDate),
    ));
  });

  // No manual disk-space reclaim step: Postgres autovacuum handles it.

  const result: CleanupResult = {
    cowork_rows_affected: coworkAffected,
    code_rows_affected: codeAffected,
    otel_rows_affected: otelAffected,
    compliance_rows_affected: complianceAffected,
    error_rows_affected: errorAffected,
    chat_rows_affected: chatAffected + chatMetaAffected,
    alerts_rows_affected: alertsAffected,
    analytics_rows_affected: analyticsAffected,
    duration_ms: Date.now() - start,
    mode,
    ...(archiveResult ? { archived: archiveResult } : {}),
  };

  // Persist last run info
  const now = new Date().toISOString();
  await setConfigValue('retentionLastRun', now);
  await setConfigValue('retentionLastResult', JSON.stringify(result));

  console.log(`[Retention] Cleanup complete (${mode}): cowork=${coworkAffected}, code=${codeAffected}, otel=${otelAffected}, compliance=${complianceAffected}, error=${errorAffected}, chat=${chatAffected}(+${chatMetaAffected} meta), code_metrics=${codeMetricsAffected}, alerts=${alertsAffected}, analytics=${analyticsAffected} in ${result.duration_ms}ms`);

  return result;
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Compliance API Activity Feed → compliance_events.
// Metadata-only audit events; LIVE-VERIFIED against the
// Enterprise tenant (real Activity Feed events syncing clean).
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { textToJsonValue } from '@/lib/db/json';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { listActivities, type ComplianceActivity, type CompliancePage } from './client';
import { resolveUserByEmail } from './chat-sync';

const MAX_PAGES_PER_RUN = 20;

// CCC's own 5-min Compliance API polling
// shows up in the Activity Feed as `compliance_api_accessed` events, which —
// if re-ingested — flood compliance_events with self-noise (126/260 rows in
// one sample). Excluded here means skipped at INSERT time only: the
// cursor still advances over an excluded row (see insertActivityPage /
// runActivitySync's use of page.last_id), so exclusion can never open a
// resume gap.
const DEFAULT_EXCLUDED_ACTIVITY_TYPES = ['compliance_api_accessed'];

function parseExcludedActivityTypes(raw: string): Set<string> {
  if (!raw) return new Set(DEFAULT_EXCLUDED_ACTIVITY_TYPES);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      return new Set(parsed);
    }
  } catch {
    // malformed config value — fall through to the safe default below
  }
  return new Set(DEFAULT_EXCLUDED_ACTIVITY_TYPES);
}

// Late-arriver mitigation: the Activity Feed docs warn that asc + after_id
// can skip a row that lands (is created) behind a cursor that has already
// advanced past it. One extra re-poll of the last hour, deduped via
// onConflictDoNothing, catches those without walking the whole history again.
const OVERLAP_MIN = 60;

function activityMetadata(a: ComplianceActivity): string {
  const { id, created_at, type, actor, ...rest } = a;
  void id; void created_at; void type;
  return JSON.stringify({
    ip_address: actor?.ip_address ?? null,
    user_agent: actor?.user_agent ?? null,
    actor_type: actor?.type ?? null,
    ...rest,
  });
}

async function insertActivityPage(
  client: Awaited<ReturnType<typeof getTypedClient>>,
  page: CompliancePage<ComplianceActivity>,
  result: { activities: number; errors: string[] },
  excludedTypes: Set<string>,
): Promise<void> {
  await withTx(client, async (tx) => {
    const nowS = Math.floor(Date.now() / 1000);
    for (const activity of page.data) {
      // Self-noise guard — skip the insert and the count, but the cursor
      // still advances (callers use page.last_id, not this loop) so an
      // excluded row never creates a resume gap.
      if (excludedTypes.has(activity.type)) continue;
      let userId: string | null = null;
      if (activity.actor?.type === 'user_actor' && activity.actor.email_address) {
        userId = await resolveUserByEmail(tx, activity.actor.email_address, activity.actor.user_id || activity.id, nowS);
      }
      await tx.insert(schema.complianceEvents).values({
        id: activity.id,
        user_id: userId,
        event_type: activity.type || 'unknown',
        surface: 'chat',
        content_preview: null,
        metadata: textToJsonValue(activityMetadata(activity)) as never,
        flagged: 0, flag_reason: null,
        occurred_at: Math.floor(new Date(activity.created_at).getTime() / 1000),
      }).onConflictDoNothing();
      result.activities++;
    }
  });
}

export async function runActivitySync(): Promise<{ activities: number; errors: string[] }> {
  const result = { activities: 0, errors: [] as string[] };
  const apiKey = await getConfigValue('complianceAccessKey');
  if (!apiKey) return result;

  const excludedTypes = parseExcludedActivityTypes(await getConfigValue('complianceActivityExcludedTypes'));

  const client = await getTypedClient();
  // complianceActivityCursor (the old key) was a DESC-cursor: the Activity
  // Feed sorts newest-first, so paging it forward with after_id actually
  // walked BACKWARD in time and new events never arrived (the bug this fixes).
  // It is abandoned here — never read, never written — in favour of a fresh
  // key so the reset is automatic and needs no manual DB step.
  let cursor = (await getConfigValue('complianceActivityCursorAsc')) || '';
  const hadCursorAtStart = !!cursor;
  const backfillDaysRaw = Number(await getConfigValue('complianceActivityBackfillDays'));
  const backfillDays = Number.isFinite(backfillDaysRaw) && backfillDaysRaw > 0 ? backfillDaysRaw : 7;
  const nowMs = Date.now();

  let pagesUsed = 0;
  try {
    for (let pageN = 0; pageN < MAX_PAGES_PER_RUN; pageN++) {
      pagesUsed++;
      // No cursor yet (first-ever run): bounded backfill window, not the full
      // history. Once a cursor exists, page forward in time via after_id.
      const opts = cursor
        ? { afterId: cursor, order: 'asc' as const }
        : { gteIso: new Date(nowMs - backfillDays * 24 * 60 * 60 * 1000).toISOString(), order: 'asc' as const };
      const page = await listActivities(apiKey, opts);
      if (page.data.length === 0) break;

      await insertActivityPage(client, page, result, excludedTypes);

      if (page.last_id) {
        cursor = page.last_id;
        await setConfigValue('complianceActivityCursorAsc', cursor);
      }
      if (!page.has_more) break;
    }

    // Overlap re-poll (see OVERLAP_MIN above). Only meaningful on a
    // cursor-walk run — the first-ever (backfill) run already covers its
    // whole window via created_at.gte — and only if this run's page budget
    // isn't already spent, so MAX_PAGES_PER_RUN stays the hard cap on
    // outbound calls per run.
    if (hadCursorAtStart && pagesUsed < MAX_PAGES_PER_RUN) {
      const overlapIso = new Date(nowMs - OVERLAP_MIN * 60 * 1000).toISOString();
      const overlapPage = await listActivities(apiKey, { gteIso: overlapIso, order: 'asc' });
      if (overlapPage.data.length > 0) {
        // Deliberately does NOT advance complianceActivityCursorAsc — this is
        // a re-poll of already-walked territory, not forward progress.
        // onConflictDoNothing makes re-inserting already-seen rows free.
        await insertActivityPage(client, overlapPage, result, excludedTypes);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly measured-impact rollup (Workflow Impact package).
 * Recomputes the impact columns on use_case_activation_weeks for one
 * (use case, week) from the junction's session ids joined to the session-stats
 * tables. Idempotent — safe to re-run as the current week's sessions finish.
 * Null semantics: no non-empty session ids for the week -> all columns null
 * ("not measured"); sessions exist -> counts are real measured zeros, except
 * engaged_secs which stays null when no attributable active_time rows exist
 * (older clients may not stamp session ids on metric data points).
 *
 * measured_duration_secs: sums each session's GAP-BASED
 * active_secs (lib/pulse/session-active-time.ts), never wall-clock duration —
 * a long-lived/persistent Cowork session can sit open for days between
 * messages, and wall time badly overstated "measured session time" as a
 * result (a real use case read 6,885.9 hours this way). A session
 * whose active_secs hasn't been (re-)computed yet is NULL, not zero, and is
 * excluded from the sum rather than silently falling back to wall time — if
 * every matched session for the week has a null active_secs, the whole
 * column goes null ("not measured"), same honesty convention as engaged_secs.
 */
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const CHUNK = 500;

export async function recomputeWeekImpact(useCaseId: string, weekStartS: number): Promise<void> {
  const client = await getTypedClient();
  const jm = schema.useCaseWeekMatches;

  const idRows = await client
    .select({ session_id: jm.session_id })
    .from(jm)
    .where(and(eq(jm.use_case_id, useCaseId), eq(jm.week_start, weekStartS), ne(jm.session_id, '')));
  let sessionIds = [...new Set(idRows.map(r => r.session_id))];

  // A session matched in two weeks (a conversation straddling the Monday-UTC
  // boundary) otherwise gets its full duration/errors/etc counted in BOTH
  // weeks, overstating sums across weeks. Attribute each session to exactly
  // ONE week — the EARLIEST week it appears in for this use case — by
  // excluding any session id that also has a junction row in an earlier week.
  if (sessionIds.length > 0) {
    const earlierIds = new Set<string>();
    for (const ids of chunk(sessionIds, CHUNK)) {
      const earlierRows = await client
        .select({ session_id: jm.session_id })
        .from(jm)
        .where(and(eq(jm.use_case_id, useCaseId), inArray(jm.session_id, ids), lt(jm.week_start, weekStartS)));
      for (const r of earlierRows) earlierIds.add(r.session_id);
    }
    sessionIds = sessionIds.filter(id => !earlierIds.has(id));
  }

  const wt = schema.useCaseActivationWeeks;
  if (sessionIds.length === 0) {
    await client.update(wt).set({
      measured_duration_secs: null, engaged_secs: null, tool_error_count: null,
      edit_reject_count: null, edit_accept_count: null, flagged_count: null,
      cowork_tool_error_count: null,
    } as never).where(and(eq(wt.use_case_id, useCaseId), eq(wt.week_start, weekStartS)));
    return;
  }

  let measuredDurationSecs: number | null = null;
  let engagedSecs: number | null = null;
  let toolErrors = 0;
  let coworkToolErrors = 0;
  let rejects = 0;
  let accepts = 0;
  let flagged = 0;

  for (const ids of chunk(sessionIds, CHUNK)) {
    const cs = schema.coworkSessionStats;
    const cwRows = await client
      .select({
        d: sql<number>`COALESCE(SUM(${cs.active_secs}), 0)`,
        n: sql<number>`COUNT(${cs.active_secs})`,
      })
      .from(cs).where(inArray(cs.session_id, ids));
    if (Number(cwRows[0]?.n ?? 0) > 0) {
      measuredDurationSecs = (measuredDurationSecs ?? 0) + Number(cwRows[0]?.d ?? 0);
    }

    const cds = schema.codeSessionStats;
    const cdRows = await client
      .select({
        d: sql<number>`COALESCE(SUM(${cds.active_secs}), 0)`,
        n: sql<number>`COUNT(${cds.active_secs})`,
        e: sql<number>`COALESCE(SUM(${cds.error_count}), 0)`,
      })
      .from(cds).where(inArray(cds.session_id, ids));
    if (Number(cdRows[0]?.n ?? 0) > 0) {
      measuredDurationSecs = (measuredDurationSecs ?? 0) + Number(cdRows[0]?.d ?? 0);
    }
    toolErrors += Number(cdRows[0]?.e ?? 0);

    const om = schema.codeOtelMetrics;
    const actRows = await client
      .select({ v: sql<number>`SUM(${om.value})`, n: sql<number>`COUNT(*)` })
      .from(om)
      .where(and(inArray(om.session_id, ids), eq(om.metric_name, 'claude_code.active_time.total')));
    if (Number(actRows[0]?.n ?? 0) > 0) engagedSecs = (engagedSecs ?? 0) + Number(actRows[0]?.v ?? 0);

    const decRows = await client
      .select({ t: om.type, v: sql<number>`COALESCE(SUM(${om.value}), 0)` })
      .from(om)
      .where(and(inArray(om.session_id, ids), eq(om.metric_name, 'claude_code.code_edit_tool.decision')))
      .groupBy(om.type);
    for (const r of decRows) {
      if (r.t === 'reject') rejects += Number(r.v);
      if (r.t === 'accept') accepts += Number(r.v);
    }

    const cm = schema.coworkMessages;
    const flRows = await client
      .select({ n: sql<number>`COUNT(*)` })
      .from(cm)
      .where(and(inArray(cm.session_id, ids), eq(cm.flagged, 1)));
    flagged += Number(flRows[0]?.n ?? 0);

    // Cowork tool failures: the Cowork OTel receiver
    // stores a per-tool-call success flag on cowork_tool_metadata rows
    // (tool_success — 0 on a reported failure, defaulting to success when the
    // attribute is absent, so this is a conservative floor). Only Cowork-
    // surface rows ever carry the flag; Code tool errors are already summed
    // from code_session_stats.error_count above, so there is no double count.
    const ctRows = await client
      .select({ n: sql<number>`COUNT(*)` })
      .from(cm)
      .where(and(
        inArray(cm.session_id, ids),
        eq(cm.message_type, 'cowork_tool_metadata'),
        eq(cm.tool_success, 0),
      ));
    coworkToolErrors += Number(ctRows[0]?.n ?? 0);
  }

  await client.update(wt).set({
    measured_duration_secs: measuredDurationSecs === null ? null : Math.round(measuredDurationSecs),
    engaged_secs: engagedSecs === null ? null : Math.round(engagedSecs),
    tool_error_count: toolErrors,
    edit_reject_count: rejects,
    edit_accept_count: accepts,
    flagged_count: flagged,
    cowork_tool_error_count: coworkToolErrors,
  } as never).where(and(eq(wt.use_case_id, useCaseId), eq(wt.week_start, weekStartS)));
}

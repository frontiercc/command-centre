// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Monthly spot-check of the by-hand estimates. An admin
// draws 20 estimated Tier 2/3 sessions per surface for the month, reads each
// one's first prompt, counts, Claude time and estimate, and marks the estimate
// about right, too high or too low (optionally with their own figure). The
// cards then say how many of the latest month's checks were judged about right,
// or "not yet checked". The draw is deterministic for a month (md5 order), so
// drawing twice gives the same sample.
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const CHECKS_PER_MONTH = 20;
export const VERDICTS = ['about_right', 'too_high', 'too_low'] as const;
export type Verdict = typeof VERDICTS[number];
export type Surface = 'code' | 'cowork';

const DAY = 86400;

export function currentPeriod(nowS = Math.floor(Date.now() / 1000)): string {
  return new Date(nowS * 1000).toISOString().slice(0, 7);
}

/** Draw the month's sample (idempotent). Returns how many rows the period now holds. */
export async function drawChecks(surface: Surface, period: string, nowS = Math.floor(Date.now() / 1000)): Promise<number> {
  const client = await getTypedClient();
  const since = nowS - 30 * DAY;
  const order = sql`md5(session_id || ${period})`;
  const picked = surface === 'code'
    ? await client.execute(sql`
        SELECT s.session_id, k.human_minutes_likely AS likely
        FROM code_session_stats s JOIN code_session_classifications k ON k.session_id = s.session_id
        WHERE k.human_minutes_likely IS NOT NULL AND s.active_secs > 0 AND s.first_at >= ${since}
        ORDER BY md5(s.session_id || ${period}) LIMIT ${CHECKS_PER_MONTH}`)
    : await client.execute(sql`
        SELECT session_id, human_minutes_likely AS likely FROM cowork_session_stats
        WHERE human_minutes_likely IS NOT NULL AND active_secs > 0 AND first_event_at >= ${since}
        ORDER BY ${order} LIMIT ${CHECKS_PER_MONTH}`);
  const rows = (picked as unknown as { rows: Array<{ session_id: string; likely: number | string }> }).rows;
  const t = schema.humanTimeChecks;
  for (const r of rows) {
    await client.insert(t).values({
      surface, session_id: r.session_id, period, human_minutes_likely: Number(r.likely), created_at: nowS,
    }).onConflictDoNothing();
  }
  const n = await client.select({ n: sql<number>`count(*)` }).from(t).where(and(eq(t.surface, surface), eq(t.period, period)));
  return Number(n[0]?.n ?? 0);
}

export interface CheckItem {
  id: number;
  sessionId: string;
  firstPrompt: string | null;
  prompts: number;
  toolCalls: number;
  claudeMinutes: number | null;
  estimate: { low: number | null; likely: number; high: number | null };
  verdict: Verdict | null;
  correctedMinutes: number | null;
}

/** The month's sample with what a reviewer needs. Contains prompt text: admin-only callers. */
export async function listChecks(surface: Surface, period: string): Promise<CheckItem[]> {
  const client = await getTypedClient();
  const t = schema.humanTimeChecks;
  const checks = await client.select().from(t).where(and(eq(t.surface, surface), eq(t.period, period))).orderBy(t.id);
  const out: CheckItem[] = [];
  for (const c of checks) {
    const msgType = surface === 'code' ? 'code_user_message' : 'cowork_user_message';
    const cm = schema.coworkMessages;
    const prompts = await client.select({ text: cm.content_preview }).from(cm)
      .where(and(eq(cm.session_id, c.session_id), eq(cm.message_type, msgType))).orderBy(cm.occurred_at);
    let toolCalls = 0; let claudeSecs: number | null = null; let low: number | null = null; let high: number | null = null;
    if (surface === 'code') {
      const r = await client.select({
        tools: schema.codeSessionStats.tool_use_count, secs: schema.codeSessionStats.active_secs,
        low: schema.codeSessionClassifications.human_minutes_low, high: schema.codeSessionClassifications.human_minutes_high,
      }).from(schema.codeSessionStats)
        .leftJoin(schema.codeSessionClassifications, eq(schema.codeSessionClassifications.session_id, schema.codeSessionStats.session_id))
        .where(eq(schema.codeSessionStats.session_id, c.session_id)).limit(1);
      if (r[0]) { toolCalls = Number(r[0].tools); claudeSecs = r[0].secs === null ? null : Number(r[0].secs); low = r[0].low; high = r[0].high; }
    } else {
      const st = schema.coworkSessionStats;
      const r = await client.select({ tools: st.tool_call_count, secs: st.active_secs, low: st.human_minutes_low, high: st.human_minutes_high })
        .from(st).where(eq(st.session_id, c.session_id)).limit(1);
      if (r[0]) { toolCalls = Number(r[0].tools); claudeSecs = r[0].secs === null ? null : Number(r[0].secs); low = r[0].low; high = r[0].high; }
    }
    out.push({
      id: Number(c.id),
      sessionId: c.session_id,
      firstPrompt: prompts[0]?.text ?? null,
      prompts: prompts.length,
      toolCalls,
      claudeMinutes: claudeSecs === null ? null : claudeSecs / 60,
      estimate: { low, likely: c.human_minutes_likely, high },
      verdict: (c.verdict as Verdict | null) ?? null,
      correctedMinutes: c.corrected_minutes,
    });
  }
  return out;
}

export async function recordCheck(id: number, verdict: Verdict, correctedMinutes: number | null, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const client = await getTypedClient();
  const t = schema.humanTimeChecks;
  const r = await client.update(t).set({ verdict, corrected_minutes: correctedMinutes, reviewed_at: nowS })
    .where(eq(t.id, id)).returning({ id: t.id });
  return r.length > 0;
}

export interface CheckResult { period: string; reviewed: number; aboutRight: number }

/** The latest month with any review, or null ("not yet checked"). Counts only. */
export async function latestCheckResult(surface: Surface): Promise<CheckResult | null> {
  const client = await getTypedClient();
  const t = schema.humanTimeChecks;
  const latest = await client.select({ period: t.period }).from(t)
    .where(and(eq(t.surface, surface), isNotNull(t.reviewed_at))).orderBy(desc(t.period)).limit(1);
  if (!latest[0]) return null;
  const rows = await client.select({ verdict: t.verdict }).from(t)
    .where(and(eq(t.surface, surface), eq(t.period, latest[0].period), isNotNull(t.reviewed_at)));
  return { period: latest[0].period, reviewed: rows.length, aboutRight: rows.filter(r => r.verdict === 'about_right').length };
}

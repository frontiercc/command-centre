// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Human time vs Claude time totals.
// Human time is a JUDGED estimate (violet); Claude time is the session's MEASURED
// gap-based active time (blue). The two are never blended: only sessions that
// carry BOTH figures are counted, so the comparison is like for like.
// Scope is decided by the caller (org = no userIds; department/person = the
// ids the route has already authorised). No visibility decisions here.
// A session whose measured active time is 0 (a single event, so the gap-based
// measure saw no duration) is NOT measured and is left out: comparing a by-hand
// estimate against 0 minutes would inflate the ratio.
import { and, eq, gt, gte, inArray, isNotNull, lt, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { Vendor } from '@/lib/dashboard/vendor';
import { codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import { buildSessionTaskTypeMap, MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { MIN_SESSIONS_FOR_RATE } from '@/lib/pulse/cowork/session-output-rate';

export const WINDOW_DAYS = 30;

export interface HumanTimeRow {
  kind: string;
  sessions: number;
  humanMinutes: number;
  claudeMinutes: number;
}

/** One product's totals (All view, once ChatGPT conversations are estimated). */
export interface HumanTimeProductTotals { sessions: number; humanMinutes: number; claudeMinutes: number }

export interface HumanTimeSummary {
  /** Work Pulse's All view: Claude Cowork's and ChatGPT's own totals. */
  byProduct?: { claude: HumanTimeProductTotals; openai: HumanTimeProductTotals };
  windowDays: number;
  sessions: number;
  humanMinutes: { low: number; likely: number; high: number };
  claudeMinutes: number;
  /** humanMinutes.likely / claudeMinutes, or null below the session floor or with no Claude time. */
  ratio: number | null;
  byKind: HumanTimeRow[];
}

interface SessionFigures {
  session_id: string;
  low: number;
  likely: number;
  high: number;
  claudeSecs: number;
  kind: string | null;
}

/** Pure: totals, ratio and the kind-of-work breakdown from per-session figures. */
export function summariseHumanTime(rows: SessionFigures[], minSessionsForRatio: number, windowDays = WINDOW_DAYS): HumanTimeSummary {
  const low = rows.reduce((s, r) => s + r.low, 0);
  const likely = rows.reduce((s, r) => s + r.likely, 0);
  const high = rows.reduce((s, r) => s + r.high, 0);
  const claudeMinutes = rows.reduce((s, r) => s + r.claudeSecs, 0) / 60;
  const byKindMap = new Map<string, HumanTimeRow>();
  for (const r of rows) {
    if (!r.kind) continue;
    const k = byKindMap.get(r.kind) ?? { kind: r.kind, sessions: 0, humanMinutes: 0, claudeMinutes: 0 };
    k.sessions++;
    k.humanMinutes += r.likely;
    k.claudeMinutes += r.claudeSecs / 60;
    byKindMap.set(r.kind, k);
  }
  return {
    windowDays,
    sessions: rows.length,
    humanMinutes: { low, likely, high },
    claudeMinutes,
    ratio: rows.length >= minSessionsForRatio && claudeMinutes > 0 ? likely / claudeMinutes : null,
    byKind: [...byKindMap.values()]
      .filter(k => k.sessions >= MIN_SESSIONS_FOR_RATE)
      .sort((a, b) => b.humanMinutes - a.humanMinutes),
  };
}

export async function buildHumanTimeSummary(opts: {
  surface: 'code' | 'cowork';
  nowS?: number;
  /** Omit for the whole organisation; an empty list means nobody (returns zero sessions). */
  userIds?: string[];
  minSessionsForRatio: number;
  /** A fixed [startS, endS) window (e.g. a completed week) instead of the last 30 days. */
  range?: { startS: number; endS: number };
  /** Developer Pulse's switch (Code), or Work Pulse's (Cowork, with includeChatgpt). */
  vendor?: Vendor;
  /**
   * Cowork only: count ChatGPT conversations too (chatgpt_session_time), as
   * Work Pulse's pages do. Off for the digest, Reports, Highlights and the
   * Metrics Connector, which describe Claude Cowork as they always have.
   */
  includeChatgpt?: boolean;
}): Promise<HumanTimeSummary> {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const since = opts.range?.startS ?? nowS - WINDOW_DAYS * 86400;
  const until = opts.range?.endS ?? null;
  const days = opts.range ? Math.round((opts.range.endS - opts.range.startS) / 86400) : WINDOW_DAYS;
  if (opts.userIds && opts.userIds.length === 0) return summariseHumanTime([], opts.minSessionsForRatio, days);
  const client = await getTypedClient();
  let rows: SessionFigures[];

  if (opts.surface === 'code') {
    const css = schema.codeSessionStats;
    const csc = schema.codeSessionClassifications;
    const where: SQL[] = [gte(css.first_at, since), isNotNull(csc.human_minutes_likely), gt(css.active_secs, 0)];
    if (until !== null) where.push(lt(css.first_at, until));
    if (opts.userIds) where.push(inArray(css.user_id, opts.userIds));
    // Developer Pulse's switch: Codex sessions are 'codex:' ids.
    if (opts.vendor && opts.vendor !== 'all') where.push(codeSessionVendor(css.session_id, opts.vendor));
    const r = await client
      .select({
        session_id: css.session_id, low: csc.human_minutes_low, likely: csc.human_minutes_likely,
        high: csc.human_minutes_high, secs: css.active_secs, kind: csc.work_type,
      })
      .from(css)
      .innerJoin(csc, eq(csc.session_id, css.session_id))
      .where(and(...where));
    rows = r.map(x => ({
      session_id: x.session_id, low: Number(x.low), likely: Number(x.likely), high: Number(x.high),
      claudeSecs: Number(x.secs), kind: x.kind,
    }));
  } else {
    const st = schema.coworkSessionStats;
    const where: SQL[] = [gte(st.first_event_at, since), isNotNull(st.human_minutes_likely), gt(st.active_secs, 0)];
    if (until !== null) where.push(lt(st.first_event_at, until));
    if (opts.userIds) where.push(inArray(st.user_id, opts.userIds));
    const withClaude = !opts.includeChatgpt || opts.vendor !== 'openai';
    const withChatgpt = !!opts.includeChatgpt && opts.vendor !== 'claude';
    const r = !withClaude ? [] : await client
      .select({
        session_id: st.session_id, low: st.human_minutes_low, likely: st.human_minutes_likely,
        high: st.human_minutes_high, secs: st.active_secs,
      })
      .from(st)
      .where(and(...where));
    if (withChatgpt) {
      const ct = schema.chatgptSessionTime;
      const cw: SQL[] = [gte(ct.first_at, since), isNotNull(ct.human_minutes_likely), gt(ct.active_secs, 0)];
      if (until !== null) cw.push(lt(ct.first_at, until));
      if (opts.userIds) cw.push(inArray(ct.user_id, opts.userIds));
      const chat = await client
        .select({
          session_id: ct.session_id, low: ct.human_minutes_low, likely: ct.human_minutes_likely,
          high: ct.human_minutes_high, secs: ct.active_secs,
        })
        .from(ct)
        .where(and(...cw));
      r.push(...chat);
    }
    // Named kinds of work only, as Session Output Rate: a mechanism-only
    // session still counts in the totals but gets no breakdown row.
    const kinds = await buildSessionTaskTypeMap(client, r.map(x => x.session_id));
    rows = r.map(x => {
      const k = kinds.get(x.session_id) ?? null;
      return {
        session_id: x.session_id, low: Number(x.low), likely: Number(x.likely), high: Number(x.high),
        claudeSecs: Number(x.secs), kind: k && !MECHANISM_TASK_TYPES.has(k) ? k : null,
      };
    });
  }
  const summary = summariseHumanTime(rows, opts.minSessionsForRatio, days);
  // Work Pulse's All view: each product's own totals, once ChatGPT conversations are estimated.
  if (opts.surface === 'cowork' && opts.includeChatgpt && (opts.vendor ?? 'all') === 'all' && rows.some(r => r.session_id.startsWith('chatgpt:'))) {
    const totals = (pick: (r: SessionFigures) => boolean) => {
      const sel = rows.filter(pick);
      return { sessions: sel.length, humanMinutes: sel.reduce((s, r) => s + r.likely, 0), claudeMinutes: sel.reduce((s, r) => s + r.claudeSecs, 0) / 60 };
    };
    summary.byProduct = { claude: totals(r => !r.session_id.startsWith('chatgpt:')), openai: totals(r => r.session_id.startsWith('chatgpt:')) };
  }
  return summary;
}

/**
 * The card payload for a route: null when the feature is switched off or the
 * read fails (the card hides; the rest of the page is unaffected). Callers
 * decide the scope and who may see it.
 */
export async function readHumanTime(surface: 'code' | 'cowork', userIds?: string[], vendor: Vendor = 'all'): Promise<(HumanTimeSummary & { check: { period: string; reviewed: number; aboutRight: number } | null }) | null> {
  try {
    const { getConfigValue } = await import('@/lib/config');
    const { humanTimeOn } = await import('@/lib/pulse/human-time-flags');
    if (!(await humanTimeOn(surface))) return null;
    const min = parseInt(await getConfigValue('humanTimeMinSessionsForRatio'), 10);
    const summary = await buildHumanTimeSummary({ surface, userIds, vendor, includeChatgpt: surface === 'cowork', minSessionsForRatio: Number.isFinite(min) && min > 0 ? min : 20 });
    // The spot-check result (counts only), so the card can say how well the estimates held up.
    const { latestCheckResult } = await import('@/lib/pulse/human-time-checks');
    return { ...summary, check: await latestCheckResult(surface) };
  } catch (e) {
    console.error('[human-time] summary failed', e);
    return null;
  }
}

export interface OrgHumanTime {
  code: HumanTimeSummary;
  cowork: HumanTimeSummary;
  /** Both surfaces added up, estimate and measured kept apart. */
  total: { sessions: number; humanMinutes: number; claudeMinutes: number };
}

/**
 * Organisation totals for a fixed window, for the digest, Highlights, Reports
 * and the Metrics Connector. Null when switched off, when nothing in the window
 * carries both figures, or on a read failure. Org-level only: no person or
 * session appears in the result.
 *
 * `openai`: true counts ChatGPT conversations beside Claude Cowork and every
 * Code session (Codex included), as Work Pulse's All view does; false counts
 * Claude alone (no ChatGPT, Claude Code sessions only), for when "Show ChatGPT
 * and Codex" is off. Omitted: Claude Cowork and every Code session, as before.
 */
export async function readOrgHumanTime(startS: number, endS: number, opts?: { openai?: boolean }): Promise<OrgHumanTime | null> {
  try {
    const { getConfigValue } = await import('@/lib/config');
    const { humanTimeOn } = await import('@/lib/pulse/human-time-flags');
    const codeOn = await humanTimeOn('code');
    const coworkOn = await humanTimeOn('cowork');
    if (!codeOn && !coworkOn) return null;
    const min = parseInt(await getConfigValue('humanTimeMinSessionsForRatio'), 10);
    const minSessionsForRatio = Number.isFinite(min) && min > 0 ? min : 20;
    const range = { startS, endS };
    // A surface that is switched off contributes nothing (shown as not measured).
    const days = Math.round((endS - startS) / 86400);
    const vendor: Vendor | undefined = opts?.openai === false ? 'claude' : undefined;
    const includeChatgpt = opts?.openai === true;
    const code = codeOn ? await buildHumanTimeSummary({ surface: 'code', range, minSessionsForRatio, vendor }) : summariseHumanTime([], minSessionsForRatio, days);
    const cowork = coworkOn ? await buildHumanTimeSummary({ surface: 'cowork', range, minSessionsForRatio, includeChatgpt }) : summariseHumanTime([], minSessionsForRatio, days);
    const sessions = code.sessions + cowork.sessions;
    if (sessions === 0) return null;
    return {
      code, cowork,
      total: {
        sessions,
        humanMinutes: code.humanMinutes.likely + cowork.humanMinutes.likely,
        claudeMinutes: code.claudeMinutes + cowork.claudeMinutes,
      },
    };
  } catch (e) {
    console.error('[human-time] org summary failed', e);
    return null;
  }
}

export { humanTimeSentence } from '@/lib/pulse/human-time';

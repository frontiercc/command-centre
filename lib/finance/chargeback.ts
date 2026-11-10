// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Chargeback rollup engine — attributes measured Code + Cowork API spend to
 * departments ("cost centres") for a given calendar-month period, plus
 * ChatGPT and Codex spend when OpenAI's Compliance API is connected (priced from
 * tokens at OpenAI's USD rates, exactly as Work Pulse and Developer Pulse
 * price them: lib/openai/spend.ts). Each person's total is all four; the
 * report also carries a Claude / OpenAI split.
 *
 * Money never gets fabricated: a model with no rate entry contributes $0 but
 * is surfaced in `unpricedModels` (never silently priced at $0 and hidden).
 * A spending user with no department (or no `users` row at all) lands in
 * `unallocated` rather than being dropped, so the report always reconciles:
 * `grandTotalUsd === Σ costCentres.totalUsd + unallocated.totalUsd` (±0.005).
 */
import { sql } from 'drizzle-orm';
import { openaiShown } from '@/lib/sources/openai-visibility';
import { getTypedClient } from '@/lib/db/client';
import { jsonToText } from '@/lib/db/json';
import { monthBounds, isCurrentMonth } from '@/lib/finance/period';
import { priceTokens, getCodeModelRates, spendIsPartlyEstimated, normalizeModelId, type ModelRates } from '@/lib/pulse/code/rates';
import { valueChatgptCost } from '@/lib/openai/cost-value';
import { resolveDeptToCentre } from '@/lib/finance/cost-centres';

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

export interface ChargebackUser {
  userId: string;
  displayName: string;
  codeUsd: number;
  coworkUsd: number;
  /** ChatGPT (Chat and Work) and Codex, at OpenAI's USD token rates. Absent on closed snapshots from before OpenAI. */
  chatgptUsd?: number;
  codexUsd?: number;
  totalUsd: number;
  /** Per-user Code token totals (exact, includes unpriced-model usage). */
  tokens: CodeTokens;
}

export interface ChargebackCentre {
  name: string;
  code: string | null;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
  chatgptUsd?: number;
  codexUsd?: number;
  users: ChargebackUser[];
}

/** Org-total Code token counts over the period (exact — even for unpriced models). */
export interface CodeTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ChargebackReport {
  period: string;
  periodStart: number;
  periodEnd: number;
  monthToDate: boolean;
  status: 'open' | 'closed';
  closedAt: number | null;
  grandTotalUsd: number;
  estimated: boolean;
  unpricedModels: string[];
  coworkCostCoverage: { withCost: number; total: number };
  /** Org-total Code token breakdown (exact, includes unpriced-model tokens). */
  codeTokens: CodeTokens;
  /**
   * List-rate ESTIMATE of $ saved by cache reads vs paying full input rate,
   * Claude's and (with OpenAI connected) ChatGPT's and Codex's cached input.
   * NOT part of grandTotalUsd (informational). null when any priced model
   * seen lacks a cache-read rate (never fabricated).
   */
  cacheSavingsUsd: number | null;
  costCentres: ChargebackCentre[];
  unallocated: { totalUsd: number; users: ChargebackUser[] };
  /** By-surface spend + token summary (Chat/Code/Cowork). */
  surfaces: SurfaceSummary;
  /**
   * Top 10 spenders by totalUsd DESC across ALL cost centres + unallocated.
   * Derived from the already-built per-user objects (single-source — no new
   * query, no re-summation). Zero-spend users are excluded.
   */
  leaderboard: LeaderboardEntry[];
  /**
   * Claude / OpenAI split of grandTotalUsd. Absent when OpenAI's Compliance API has
   * never sent a ChatGPT cost record or a Codex turn (and on old snapshots).
   */
  vendors?: { claudeUsd: number; openaiUsd: number };
  /** ChatGPT and Codex models seen with no rate: their usage is not in any figure. */
  openaiUnpricedModels?: string[];
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
  chatgptUsd?: number;
  codexUsd?: number;
}

/**
 * How a surface's `usd` figure was derived:
 * - 'actual'   — measured spend, e.g. Cowork's stored per-request `cost_usd`.
 * - 'estimate' — priced from token counts via list-rate model tables, e.g. Code.
 * - 'dormant'  — surface not yet captured/priced (Chat, Phase B).
 * - 'openai_rates' — ChatGPT and Codex: tokens priced at OpenAI's USD rates
 *   for token-based Enterprise contracts.
 */
export type SurfaceBasis = 'actual' | 'estimate' | 'dormant' | 'openai_rates';

export interface SurfaceSpend {
  usd: number | null;
  tokens: CodeTokens;
  basis: SurfaceBasis;
}

export interface SurfaceSummary {
  chat: SurfaceSpend;
  code: SurfaceSpend;
  cowork: SurfaceSpend;
  /** Present only with OpenAI data (see ChargebackReport.vendors). */
  chatgpt?: SurfaceSpend;
  codex?: SurfaceSpend;
  total: { usd: number; tokens: CodeTokens };
}

const UNALLOCATED_DISPLAY_NAME = '(unknown)';

interface MutableUser {
  userId: string;
  displayName: string;
  codeUsd: number;
  coworkUsd: number;
  chatgptUsd: number;
  codexUsd: number;
  tokens: CodeTokens;
  /** Spend per part of the month, for a person who moved department (department sync). */
  segs?: Map<number, SegSpend>;
}

interface SegSpend { codeUsd: number; coworkUsd: number; chatgptUsd: number; codexUsd: number; tokens: CodeTokens }

/** A department move during the month: before changedAt the person was in `from`, after it in `to`. */
interface Move { changedAt: number; from: string; to: string }

/**
 * One entry per person: a person who moved department during the month has a
 * part in each department's list, and these add their parts back together.
 * Used wherever spend is read per person rather than per department.
 */
export function mergeUsersById(users: ChargebackUser[]): ChargebackUser[] {
  const byId = new Map<string, ChargebackUser>();
  for (const u of users) {
    const prev = byId.get(u.userId);
    if (!prev) { byId.set(u.userId, { ...u, tokens: { ...u.tokens } }); continue; }
    prev.codeUsd += u.codeUsd;
    prev.coworkUsd += u.coworkUsd;
    if (u.chatgptUsd !== undefined) prev.chatgptUsd = (prev.chatgptUsd ?? 0) + u.chatgptUsd;
    if (u.codexUsd !== undefined) prev.codexUsd = (prev.codexUsd ?? 0) + u.codexUsd;
    prev.totalUsd += u.totalUsd;
    prev.tokens.input += u.tokens.input;
    prev.tokens.output += u.tokens.output;
    prev.tokens.cacheWrite += u.tokens.cacheWrite;
    prev.tokens.cacheRead += u.tokens.cacheRead;
  }
  return [...byId.values()];
}

/**
 * Resolve the effective user_id key + fallback display name for a possibly-
 * NULL user_id column. NULL user_id rows are pooled under a single synthetic
 * key so their spend still reconciles under Unallocated.
 */
const NULL_USER_KEY = '__null_user__';

export async function buildChargeback(period: string, nowS: number = Math.floor(Date.now() / 1000)): Promise<ChargebackReport> {
  const db = await getTypedClient();

  // Period lock: a CLOSED period returns its immutable snapshot VERBATIM,
  // short-circuiting BEFORE any spend query — never recomputes. snapshot_json
  // stayed `text()` on Postgres, so it comes back as a JSON string
  // and JSON.parse is correct without jsonb handling.
  const closedRows = await rawAll<{ status: string; snapshot_json: string | null }>(
    db,
    sql`SELECT status, snapshot_json FROM chargeback_periods WHERE period = ${period}`
  );
  const closedRow = closedRows[0];
  if (closedRow?.status === 'closed' && closedRow.snapshot_json) {
    return JSON.parse(closedRow.snapshot_json) as ChargebackReport; // immutable — never recompute
  }

  const { start, end } = monthBounds(period);
  const rates: ModelRates = await getCodeModelRates();

  // Department moves during the month (department sync, migration 0049). A
  // move recorded by the directory splits the person's spend at the move: the
  // part before counts to the old department, the part after to the new one.
  // A person with a manual change this month is not split: a manual
  // department applies to the whole open month. With no moves (the usual
  // case) every query below is exactly as before.
  const moveRows = await rawAll<{ user_id: string; changed_at: number | string; from_department: string | null; to_department: string | null }>(
    db,
    sql`SELECT user_id, changed_at, from_department, to_department
       FROM department_history
       WHERE is_move = 1 AND user_id IS NOT NULL AND changed_at >= ${start} AND changed_at < ${end}
         AND user_id NOT IN (SELECT user_id FROM department_history
                             WHERE source = 'manual' AND user_id IS NOT NULL AND changed_at >= ${start} AND changed_at < ${end})
       ORDER BY user_id, changed_at`
  );
  const moves = new Map<string, Move[]>();
  for (const r of moveRows) {
    if (!r.from_department || !r.to_department) continue;
    const list = moves.get(r.user_id) ?? [];
    list.push({ changedAt: Number(r.changed_at), from: r.from_department, to: r.to_department });
    moves.set(r.user_id, list);
  }
  const moverIds = [...moves.keys()];
  /** Which part of the month a row falls in: the number of moves at or before its time; 0 for everyone else. */
  const segOf = (table: string, timeCol: string) => moverIds.length === 0
    ? sql`0`
    : sql`CASE WHEN ${sql.raw(table)}.user_id IN (${sql.join(moverIds.map(id => sql`${id}`), sql`, `)})
              THEN (SELECT COUNT(*) FROM department_history h
                    WHERE h.user_id = ${sql.raw(table)}.user_id AND h.is_move = 1
                      AND h.changed_at >= ${start} AND h.changed_at <= ${sql.raw(table)}.${sql.raw(timeCol)})
              ELSE 0 END`;

  const users = new Map<string, MutableUser>();
  const unpricedModels = new Set<string>();
  const modelsSeen: string[] = [];
  const codeTokens: CodeTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  // Cache-savings estimate: cache-read tokens cost (in − cacheRead) less than
  // full input. Accumulate for priced models only; if any priced model lacks a
  // usable cache-read rate we can't estimate honestly → null.
  let cacheSavingsUsd = 0;
  let cacheSavingsUnknown = false;
  // Surface totals — accumulated alongside the per-user loops below.
  let codeSurfaceUsd = 0;
  let coworkSurfaceUsd = 0;
  const coworkSurfaceTokens: CodeTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  function getUser(userId: string | null): MutableUser {
    const key = userId ?? NULL_USER_KEY;
    let u = users.get(key);
    if (!u) {
      u = { userId: key, displayName: key, codeUsd: 0, coworkUsd: 0, chatgptUsd: 0, codexUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
      users.set(key, u);
    }
    return u;
  }
  function segOfUser(u: MutableUser, seg: number | string | null | undefined): SegSpend | null {
    if (!moves.has(u.userId)) return null;
    const n = Number(seg ?? 0);
    if (!u.segs) u.segs = new Map();
    let part = u.segs.get(n);
    if (!part) {
      part = { codeUsd: 0, coworkUsd: 0, chatgptUsd: 0, codexUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
      u.segs.set(n, part);
    }
    return part;
  }

  // --- Code spend per (user_id, model) ---
  // Policy B: SUM() of integer columns comes back as bigint → a STRING from a
  // raw pg query. Every token total is Number()-coerced at the read site
  // below before any
  // arithmetic or being handed to priceTokens — a string here would corrupt
  // both the token totals and the priced spend that feeds grandTotalUsd.
  const codeRows = await rawAll<{
    user_id: string | null;
    model: string | null;
    i: number | string | null;
    o: number | string | null;
    cw: number | string | null;
    cr: number | string | null;
    seg: number | string | null;
  }>(
    db,
    sql`SELECT user_id, model,
              SUM(input_tokens) AS i, SUM(output_tokens) AS o,
              SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr,
              ${segOf('code_assistant_meta', 'occurred_at')} AS seg
       FROM code_assistant_meta
       WHERE occurred_at >= ${start} AND occurred_at < ${end}
       GROUP BY user_id, model, seg`
  );

  for (const row of codeRows) {
    // Token totals are exact and count ALL usage, including rows whose model
    // is unpriced or NULL — tokens are real even when we can't price them.
    const ti = Number(row.i ?? 0), to = Number(row.o ?? 0), tcw = Number(row.cw ?? 0), tcr = Number(row.cr ?? 0);
    codeTokens.input += ti;
    codeTokens.output += to;
    codeTokens.cacheWrite += tcw;
    codeTokens.cacheRead += tcr;
    // Attribute tokens to the user regardless of whether the model prices.
    const tu = getUser(row.user_id);
    tu.tokens.input += ti;
    tu.tokens.output += to;
    tu.tokens.cacheWrite += tcw;
    tu.tokens.cacheRead += tcr;
    const ts = segOfUser(tu, row.seg);
    if (ts) { ts.tokens.input += ti; ts.tokens.output += to; ts.tokens.cacheWrite += tcw; ts.tokens.cacheRead += tcr; }

    if (!row.model) continue;
    modelsSeen.push(row.model);
    const usd = priceTokens(
      row.model,
      {
        inputTokens: ti,
        outputTokens: to,
        cacheCreationTokens: tcw,
        cacheReadTokens: tcr,
      },
      rates
    );
    if (usd === null) {
      unpricedModels.add(row.model);
      continue;
    }
    const u = getUser(row.user_id);
    u.codeUsd += usd;
    const us = segOfUser(u, row.seg);
    if (us) us.codeUsd += usd;
    codeSurfaceUsd += usd;

    // Cache-savings estimate for this priced model.
    const r = rates[row.model] ?? rates[normalizeModelId(row.model)];
    if (r && typeof r.in === 'number' && typeof r.cacheRead === 'number') {
      cacheSavingsUsd += (tcr / 1_000_000) * (r.in - r.cacheRead);
    } else {
      cacheSavingsUnknown = true;
    }
  }

  // --- Cowork spend per user ---
  // Policy B: cost_usd is `numeric` on Postgres, so SUM(cost_usd) comes back
  // as a STRING — Number()-coerced before it feeds coworkUsd / grandTotalUsd
  // (a string here would break the reconciliation invariant).
  const coworkRows = await rawAll<{ user_id: string | null; c: number | string | null; seg: number | string | null }>(
    db,
    sql`SELECT user_id, COALESCE(SUM(cost_usd), 0) AS c, ${segOf('cowork_messages', 'occurred_at')} AS seg
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND product IS NULL AND occurred_at >= ${start} AND occurred_at < ${end}
       GROUP BY user_id, seg`
  );

  for (const row of coworkRows) {
    const u = getUser(row.user_id);
    const c = Number(row.c ?? 0);
    u.coworkUsd += c;
    const us = segOfUser(u, row.seg);
    if (us) us.coworkUsd += c;
    coworkSurfaceUsd += c;
  }

  // Cowork queries here exclude Claude in Office rows (product IS NOT NULL):
  // Office sends no cost, so it would add tokens without spend to the Cowork
  // tile and look like uncosted Cowork requests. Office spend is a separate
  // estimate (lib/finance/office-spend.ts), never part of these totals.
  // --- Cowork surface tokens (parsed from token_usage JSON, malformed/null skipped) ---
  // token_usage is `jsonb` (codec returns a parsed object) — jsonToText()
  // normalises it back to a JSON string for JSON.parse() below.
  const coworkTokenRows = await rawAll<{ token_usage: unknown }>(
    db,
    sql`SELECT token_usage
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND product IS NULL AND occurred_at >= ${start} AND occurred_at < ${end}`
  );

  for (const row of coworkTokenRows) {
    const rawJson = jsonToText(row.token_usage);
    if (!rawJson) continue;
    let parsed: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue; // malformed JSON — skip this row, never throw
    }
    if (!parsed || typeof parsed !== 'object') continue;
    coworkSurfaceTokens.input += Number(parsed.inputTokens) || 0;
    coworkSurfaceTokens.output += Number(parsed.outputTokens) || 0;
    coworkSurfaceTokens.cacheWrite += Number(parsed.cacheCreationTokens) || 0;
    coworkSurfaceTokens.cacheRead += Number(parsed.cacheReadTokens) || 0;
  }

  // --- ChatGPT and Codex (OpenAI Compliance API) ---
  // Same pricing as lib/openai/spend.ts: ChatGPT is the tokens in OpenAI's
  // hourly cost records (product 'chatgpt'; Codex cost records are left out,
  // since Codex is priced per turn), Codex each turn's tokens, both from the
  // rates table. A model with no rate is named, never counted as $0. Tokens
  // stay apart from Claude's token totals. Bigint/numeric sums are strings.
  const openaiSeen = await rawAll<{ x: number }>(
    db,
    sql`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM openai_costs WHERE product = 'chatgpt')
                        OR EXISTS (SELECT 1 FROM codex_turns)`
  );
  // Hidden on the OpenAI panel: FinOps reads as Claude-only (a closed period keeps its snapshot).
  const hasOpenAi = openaiSeen.length > 0 && await openaiShown();
  const openaiUnpriced = new Set<string>();
  let chatgptSurfaceUsd: number | null = null;
  let codexSurfaceUsd = 0;
  const chatgptTokens: CodeTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const codexTokens: CodeTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  if (hasOpenAi) {
    const anyChatgpt = await rawAll<{ x: number }>(db, sql`SELECT 1 AS x FROM openai_costs WHERE product = 'chatgpt' LIMIT 1`);
    if (anyChatgpt.length > 0) chatgptSurfaceUsd = 0;
    const openaiRows = async (query: unknown) => rawAll<{
      user_id: string | null; model: string | null;
      inp: number | string | null; cached: number | string | null; outp: number | string | null;
      // ChatGPT only: a group of records with no token split, valued at OpenAI's figure.
      no_split?: boolean; reported?: number | string | null; unknown_usd?: number | string | null;
      seg?: number | string | null;
    }>(db, query);
    const priceInto = (
      rows: Awaited<ReturnType<typeof openaiRows>>,
      tokens: CodeTokens,
      add: (u: MutableUser, usd: number, part: SegSpend | null) => void,
    ) => {
      for (const row of rows) {
        const inp = Number(row.inp ?? 0), cached = Number(row.cached ?? 0), outp = Number(row.outp ?? 0);
        tokens.input += inp;
        tokens.output += outp;
        tokens.cacheRead += cached;
        // Listed even when unpriced, as Claude Code's users are.
        const u = getUser(row.user_id);
        const usage = { inputTokens: inp, outputTokens: outp, cacheReadTokens: cached, cacheCreationTokens: 0 };
        // A ChatGPT record with no token split is valued at OpenAI's own figure (lib/openai/cost-value.ts).
        const usd = row.no_split
          ? valueChatgptCost(row.model, usage, Number(row.reported ?? 0), rates)
          : row.model === null ? null : priceTokens(row.model, usage, rates);
        if (row.no_split && Number(row.unknown_usd ?? 0) > 0) openaiUnpriced.add(row.model ?? '(no model)');
        if (usd === null) { openaiUnpriced.add(row.model ?? '(no model)'); continue; }
        add(u, usd, segOfUser(u, row.seg));
        // Cached input is billed at OpenAI's discounted rate: the saving joins the caching estimate.
        const r = rates[row.model!] ?? rates[normalizeModelId(row.model!)];
        if (r && typeof r.in === 'number' && typeof r.cacheRead === 'number') {
          cacheSavingsUsd += (cached / 1_000_000) * (r.in - r.cacheRead);
        } else if (cached > 0) {
          cacheSavingsUnknown = true;
        }
      }
    };
    priceInto(await openaiRows(sql`
      SELECT user_id, model, (input_tokens + cached_input_tokens + output_tokens = 0) AS no_split,
             SUM(input_tokens) AS inp, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS outp,
             SUM(cost_usd) AS reported, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_usd,
             ${segOf('openai_costs', 'hour_start')} AS seg
      FROM openai_costs
      WHERE product = 'chatgpt' AND hour_start >= ${start} AND hour_start < ${end}
      GROUP BY user_id, model, no_split, seg`), chatgptTokens, (u, usd, part) => { u.chatgptUsd += usd; if (part) part.chatgptUsd += usd; chatgptSurfaceUsd = (chatgptSurfaceUsd ?? 0) + usd; });
    priceInto(await openaiRows(sql`
      SELECT user_id, model, SUM(uncached_input_tokens) AS inp, SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS outp,
             ${segOf('codex_turns', 'started_at')} AS seg
      FROM codex_turns
      WHERE started_at >= ${start} AND started_at < ${end}
      GROUP BY user_id, model, seg`), codexTokens, (u, usd, part) => { u.codexUsd += usd; if (part) part.codexUsd += usd; codexSurfaceUsd += usd; });
  }

  // --- Cowork cost coverage ---
  // COUNT/SUM come back as bigint → STRING on Postgres; Number()-coerce both.
  const coverageRows = await rawAll<{ total: number | string | null; with_cost: number | string | null }>(
    db,
    sql`SELECT COUNT(*) AS total,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS with_cost
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND product IS NULL AND occurred_at >= ${start} AND occurred_at < ${end}`
  );
  const coverageRow = coverageRows[0];
  const coworkCostCoverage = {
    total: Number(coverageRow?.total ?? 0),
    withCost: Number(coverageRow?.with_cost ?? 0),
  };

  // --- Department lookup ---
  const userRows = await rawAll<{
    id: string;
    display_name: string | null;
    department: string | null;
  }>(db, sql`SELECT id, display_name, department FROM users`);
  const deptByUserId = new Map<string, { displayName: string | null; department: string | null }>();
  for (const row of userRows) {
    deptByUserId.set(row.id, { displayName: row.display_name, department: row.department });
  }
  const deptToCentre = await resolveDeptToCentre();

  // --- Bucket users into cost centres / unallocated ---
  const centreMap = new Map<string, ChargebackCentre>();
  const unallocatedUsers: ChargebackUser[] = [];
  let grandTotalUsd = 0;

  let openaiTotalUsd = 0;
  for (const u of users.values()) {
    const totalUsd = u.codeUsd + u.coworkUsd + u.chatgptUsd + u.codexUsd;
    grandTotalUsd += totalUsd;
    openaiTotalUsd += u.chatgptUsd + u.codexUsd;

    const isNullUser = u.userId === NULL_USER_KEY;
    const userRow = isNullUser ? undefined : deptByUserId.get(u.userId);
    const displayName = isNullUser
      ? UNALLOCATED_DISPLAY_NAME
      : userRow?.displayName || u.userId;

    // The person's spend in each department they were in this month: one
    // part for almost everyone, one per department for someone who moved.
    const userMoves = moves.get(u.userId);
    const parts: Array<{ department: string | null | undefined; amounts: SegSpend }> = userMoves && u.segs
      ? [...u.segs.entries()].sort((a, b) => a[0] - b[0]).map(([seg, amounts]) => ({
          department: seg === 0 ? userMoves[0].from : userMoves[Math.min(seg, userMoves.length) - 1].to,
          amounts,
        }))
      : [{ department: isNullUser ? null : userRow?.department, amounts: u }];

    for (const part of parts) {
      const a = part.amounts;
      const chargebackUser: ChargebackUser = {
        userId: isNullUser ? UNALLOCATED_DISPLAY_NAME : u.userId,
        displayName,
        codeUsd: a.codeUsd,
        coworkUsd: a.coworkUsd,
        ...(hasOpenAi ? { chatgptUsd: a.chatgptUsd, codexUsd: a.codexUsd } : {}),
        totalUsd: a.codeUsd + a.coworkUsd + a.chatgptUsd + a.codexUsd,
        tokens: a.tokens,
      };

      const department = part.department;
      if (department && department.trim() !== '') {
        const mapped = deptToCentre.get(department);
        const centreName = mapped ? mapped.name : department;
        const centreCode = mapped ? mapped.code : null;
        let centre = centreMap.get(centreName);
        if (!centre) {
          centre = { name: centreName, code: centreCode, totalUsd: 0, codeUsd: 0, coworkUsd: 0, ...(hasOpenAi ? { chatgptUsd: 0, codexUsd: 0 } : {}), users: [] };
          centreMap.set(centreName, centre);
        }
        centre.users.push(chargebackUser);
        centre.codeUsd += chargebackUser.codeUsd;
        centre.coworkUsd += chargebackUser.coworkUsd;
        if (hasOpenAi) {
          centre.chatgptUsd = (centre.chatgptUsd ?? 0) + (chargebackUser.chatgptUsd ?? 0);
          centre.codexUsd = (centre.codexUsd ?? 0) + (chargebackUser.codexUsd ?? 0);
        }
        centre.totalUsd += chargebackUser.totalUsd;
      } else {
        unallocatedUsers.push(chargebackUser);
      }
    }
  }

  const unallocatedTotalUsd = unallocatedUsers.reduce((s, u) => s + u.totalUsd, 0);

  // --- Reconciliation invariant (hard fail) ---
  const centresTotal = Array.from(centreMap.values()).reduce((s, c) => s + c.totalUsd, 0);
  const reconciled = centresTotal + unallocatedTotalUsd;
  if (Math.abs(grandTotalUsd - reconciled) > 0.005) {
    throw new Error(
      `Chargeback reconciliation failed for period ${period}: grandTotalUsd=${grandTotalUsd} but centres+unallocated=${reconciled}`
    );
  }

  // --- Sort for deterministic output ---
  const costCentres = Array.from(centreMap.values()).sort((a, b) => b.totalUsd - a.totalUsd);
  for (const centre of costCentres) {
    centre.users.sort((a, b) => b.totalUsd - a.totalUsd);
  }
  unallocatedUsers.sort((a, b) => b.totalUsd - a.totalUsd);

  // --- Top-spenders leaderboard (single-source: flatten the already-built
  // per-user objects across centres + unallocated; no new query/re-sum). A
  // person who moved department this month has a part in two lists: merged
  // back into one entry here. ---
  const allUsers: ChargebackUser[] = mergeUsersById([
    ...costCentres.flatMap(c => c.users),
    ...unallocatedUsers,
  ]);
  const leaderboard: LeaderboardEntry[] = allUsers
    .filter(u => u.totalUsd > 0)
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 10)
    .map(u => ({
      userId: u.userId,
      displayName: u.displayName,
      totalUsd: u.totalUsd,
      codeUsd: u.codeUsd,
      coworkUsd: u.coworkUsd,
      ...(hasOpenAi ? { chatgptUsd: u.chatgptUsd ?? 0, codexUsd: u.codexUsd ?? 0 } : {}),
    }));

  // --- By-surface summary (Chat/Code/Cowork) ---
  const chatSurface: SurfaceSpend = {
    usd: null,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    basis: 'dormant',
  };
  const codeSurface: SurfaceSpend = { usd: codeSurfaceUsd, tokens: codeTokens, basis: 'estimate' };
  const coworkSurface: SurfaceSpend = { usd: coworkSurfaceUsd, tokens: coworkSurfaceTokens, basis: 'actual' };
  const openaiTokens = (t: CodeTokens) => (hasOpenAi ? t : { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const surfaces: SurfaceSummary = {
    chat: chatSurface,
    code: codeSurface,
    cowork: coworkSurface,
    ...(hasOpenAi ? {
      chatgpt: { usd: chatgptSurfaceUsd, tokens: chatgptTokens, basis: 'openai_rates' as const },
      codex: { usd: codexSurfaceUsd, tokens: codexTokens, basis: 'openai_rates' as const },
    } : {}),
    total: {
      usd: codeSurfaceUsd + coworkSurfaceUsd + (chatgptSurfaceUsd ?? 0) + codexSurfaceUsd,
      tokens: {
        input: codeTokens.input + coworkSurfaceTokens.input + openaiTokens(chatgptTokens).input + openaiTokens(codexTokens).input,
        output: codeTokens.output + coworkSurfaceTokens.output + openaiTokens(chatgptTokens).output + openaiTokens(codexTokens).output,
        cacheWrite: codeTokens.cacheWrite + coworkSurfaceTokens.cacheWrite,
        cacheRead: codeTokens.cacheRead + coworkSurfaceTokens.cacheRead + openaiTokens(chatgptTokens).cacheRead + openaiTokens(codexTokens).cacheRead,
      },
    },
  };

  return {
    period,
    periodStart: start,
    periodEnd: end,
    monthToDate: isCurrentMonth(period, nowS),
    status: 'open',
    closedAt: null,
    grandTotalUsd,
    estimated: spendIsPartlyEstimated(modelsSeen, rates),
    unpricedModels: Array.from(unpricedModels).sort(),
    coworkCostCoverage,
    codeTokens,
    cacheSavingsUsd: cacheSavingsUnknown ? null : cacheSavingsUsd,
    costCentres,
    unallocated: { totalUsd: unallocatedTotalUsd, users: unallocatedUsers },
    surfaces,
    leaderboard,
    ...(hasOpenAi ? {
      vendors: { claudeUsd: grandTotalUsd - openaiTotalUsd, openaiUsd: openaiTotalUsd },
      openaiUnpricedModels: Array.from(openaiUnpriced).sort(),
    } : {}),
  };
}

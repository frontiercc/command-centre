// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Chargeback rollup engine — attributes measured Code + Cowork API spend to
 * departments ("cost centres") for a given calendar-month period.
 *
 * Money never gets fabricated: a model with no rate entry contributes $0 but
 * is surfaced in `unpricedModels` (never silently priced at $0 and hidden).
 * A spending user with no department (or no `users` row at all) lands in
 * `unallocated` rather than being dropped, so the report always reconciles:
 * `grandTotalUsd === Σ costCentres.totalUsd + unallocated.totalUsd` (±0.005).
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { jsonToText } from '@/lib/db/json';
import { monthBounds, isCurrentMonth } from '@/lib/finance/period';
import { priceTokens, getCodeModelRates, spendIsPartlyEstimated, normalizeModelId, type ModelRates } from '@/lib/pulse/code/rates';
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
   * List-rate ESTIMATE of $ saved by cache reads vs paying full input rate.
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
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
}

/**
 * How a surface's `usd` figure was derived:
 * - 'actual'   — measured spend, e.g. Cowork's stored per-request `cost_usd`.
 * - 'estimate' — priced from token counts via list-rate model tables, e.g. Code.
 * - 'dormant'  — surface not yet captured/priced (Chat, Phase B).
 */
export type SurfaceBasis = 'actual' | 'estimate' | 'dormant';

export interface SurfaceSpend {
  usd: number | null;
  tokens: CodeTokens;
  basis: SurfaceBasis;
}

export interface SurfaceSummary {
  chat: SurfaceSpend;
  code: SurfaceSpend;
  cowork: SurfaceSpend;
  total: { usd: number; tokens: CodeTokens };
}

const UNALLOCATED_DISPLAY_NAME = '(unknown)';

interface MutableUser {
  userId: string;
  displayName: string;
  codeUsd: number;
  coworkUsd: number;
  tokens: CodeTokens;
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
      u = { userId: key, displayName: key, codeUsd: 0, coworkUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
      users.set(key, u);
    }
    return u;
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
  }>(
    db,
    sql`SELECT user_id, model,
              SUM(input_tokens) AS i, SUM(output_tokens) AS o,
              SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
       FROM code_assistant_meta
       WHERE occurred_at >= ${start} AND occurred_at < ${end}
       GROUP BY user_id, model`
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
  const coworkRows = await rawAll<{ user_id: string | null; c: number | string | null }>(
    db,
    sql`SELECT user_id, COALESCE(SUM(cost_usd), 0) AS c
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND occurred_at >= ${start} AND occurred_at < ${end}
       GROUP BY user_id`
  );

  for (const row of coworkRows) {
    const u = getUser(row.user_id);
    const c = Number(row.c ?? 0);
    u.coworkUsd += c;
    coworkSurfaceUsd += c;
  }

  // --- Cowork surface tokens (parsed from token_usage JSON, malformed/null skipped) ---
  // token_usage is `jsonb` (codec returns a parsed object) — jsonToText()
  // normalises it back to a JSON string for JSON.parse() below.
  const coworkTokenRows = await rawAll<{ token_usage: unknown }>(
    db,
    sql`SELECT token_usage
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND occurred_at >= ${start} AND occurred_at < ${end}`
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

  // --- Cowork cost coverage ---
  // COUNT/SUM come back as bigint → STRING on Postgres; Number()-coerce both.
  const coverageRows = await rawAll<{ total: number | string | null; with_cost: number | string | null }>(
    db,
    sql`SELECT COUNT(*) AS total,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS with_cost
       FROM cowork_messages
       WHERE message_type = 'cowork_api_request' AND occurred_at >= ${start} AND occurred_at < ${end}`
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

  for (const u of users.values()) {
    const totalUsd = u.codeUsd + u.coworkUsd;
    grandTotalUsd += totalUsd;

    const isNullUser = u.userId === NULL_USER_KEY;
    const userRow = isNullUser ? undefined : deptByUserId.get(u.userId);
    const displayName = isNullUser
      ? UNALLOCATED_DISPLAY_NAME
      : userRow?.displayName || u.userId;

    const chargebackUser: ChargebackUser = {
      userId: isNullUser ? UNALLOCATED_DISPLAY_NAME : u.userId,
      displayName,
      codeUsd: u.codeUsd,
      coworkUsd: u.coworkUsd,
      totalUsd,
      tokens: u.tokens,
    };

    const department = isNullUser ? null : userRow?.department;
    if (department && department.trim() !== '') {
      const mapped = deptToCentre.get(department);
      const centreName = mapped ? mapped.name : department;
      const centreCode = mapped ? mapped.code : null;
      let centre = centreMap.get(centreName);
      if (!centre) {
        centre = { name: centreName, code: centreCode, totalUsd: 0, codeUsd: 0, coworkUsd: 0, users: [] };
        centreMap.set(centreName, centre);
      }
      centre.users.push(chargebackUser);
      centre.codeUsd += chargebackUser.codeUsd;
      centre.coworkUsd += chargebackUser.coworkUsd;
      centre.totalUsd += chargebackUser.totalUsd;
    } else {
      unallocatedUsers.push(chargebackUser);
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
  // per-user objects across centres + unallocated; no new query/re-sum) ---
  const allUsers: ChargebackUser[] = [
    ...costCentres.flatMap(c => c.users),
    ...unallocatedUsers,
  ];
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
    }));

  // --- By-surface summary (Chat/Code/Cowork) ---
  const chatSurface: SurfaceSpend = {
    usd: null,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    basis: 'dormant',
  };
  const codeSurface: SurfaceSpend = { usd: codeSurfaceUsd, tokens: codeTokens, basis: 'estimate' };
  const coworkSurface: SurfaceSpend = { usd: coworkSurfaceUsd, tokens: coworkSurfaceTokens, basis: 'actual' };
  const surfaces: SurfaceSummary = {
    chat: chatSurface,
    code: codeSurface,
    cowork: coworkSurface,
    total: {
      usd: codeSurfaceUsd + coworkSurfaceUsd,
      tokens: {
        input: codeTokens.input + coworkSurfaceTokens.input,
        output: codeTokens.output + coworkSurfaceTokens.output,
        cacheWrite: codeTokens.cacheWrite + coworkSurfaceTokens.cacheWrite,
        cacheRead: codeTokens.cacheRead + coworkSurfaceTokens.cacheRead,
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
  };
}

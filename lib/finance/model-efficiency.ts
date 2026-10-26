// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps — Model Efficiency engine.
 *
 * Visibility-first: an activity × model × cost cross-tab per surface, plus a
 * neutral, data-driven "worth reviewing" flag for activities where a high
 * share of spend ran on the top-priced model. CCC does not measure output
 * quality, so this NEVER prescribes a switch — only flags a candidate for
 * human review, always carrying an estimated-ceiling caveat.
 *
 * Reuses the exact Developer Pulse spend primitive (`priceTokens` /
 * `lib/pulse/code/rates.ts`) — no parallel cost math. Money is never
 * fabricated: an unpriced model contributes neither spend nor tokens to any
 * activity total and is surfaced in `unpricedModels` instead (never $0).
 *
 * `deriveFlag` is defined once here and reused, unmodified, by both the Code
 * and Cowork branches.
 *
 * Cowork spend is MEASURED (the stored `cowork_messages.cost_usd`), never
 * re-derived from tokens — unlike Code, where spend IS the token-priced
 * figure. Tokens (parsed from `token_usage`) feed ONLY the opportunity
 * flag's estimated ceiling; a row with no parseable tokens still counts its
 * real cost_usd toward spend (see `parseCoworkTokenUsage`).
 */
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeModelRates, priceTokens, normalizeModelId, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';
import { monthBounds } from '@/lib/finance/period';
import { rankModelsByPrice, nextCheaperInUse, estimateCeilingUsd } from '@/lib/finance/model-tiering';
import { jsonToText } from '@/lib/db/json';

export type Surface = 'code' | 'cowork';

export interface ModelSpend {
  model: string;
  tier: number;
  spendUsd: number;
  tokens: number;
}

export interface MeasuredBreakdownItem {
  dimension: string;
  key: string;
  spendUsd: number;
  /** Invocation count — populated INSTEAD of `spendUsd` (which stays 0) for
   * dimensions with no per-event dollar figure (Cowork's skill/connector
   * drill-down: neither `cowork_skill_invocations` nor
   * `cowork_mcp_invocations` carries a cost — Cowork prices at the
   * api_request level, not per tool call). The Code branch never sets this. */
  count?: number;
}

export interface OpportunityFlag {
  premiumModel: string;
  premiumShare: number;
  targetModel: string | null;
  estCeilingUsd: number | null;
  shareBasedOnly?: true;
  suppressedReason?: 'high_friction' | 'low_volume';
}

export interface ActivityRow {
  key: string;
  label: string;
  judged: true;
  totalSpendUsd: number;
  tokens: number;
  byModel: ModelSpend[];
  measuredBreakdown: MeasuredBreakdownItem[];
  friction: number | null;
  flag?: OpportunityFlag;
}

export interface ModelEfficiencyReport {
  surface: Surface;
  enabled: boolean;
  hasData: boolean;
  period: { start: number; end: number };
  totals: { spendUsd: number; tokens: number };
  activities: ActivityRow[];
  unpricedModels: string[];
  belowVolume: { key: string; label: string; totalSpendUsd: number }[];
  /** Distinct priced models across every activity's `byModel`, ranked
   * most-expensive-first via `rankModelsByPrice` — the global price ordering
   * the UI uses to assign each model ONE stable colour (same shade for a
   * given model on every row), instead of the old per-activity tier rank
   * (which coloured the same model differently row to row). Priced-only,
   * same as `byModel` — unpriced models never appear here. */
  modelOrder: string[];
  /** Measured cache-read efficiency for the selected surface's period,
   * computed by `computeCacheEfficiency` over the total `TokenUsage` summed
   * across every activity's already-aggregated `usageByModel` (the same
   * per-model usage the opportunity-flag ceiling math reads). `ratio` is
   * null (never 0) when there is no input-side token volume to divide by. */
  cacheEfficiency: ReturnType<typeof computeCacheEfficiency>;
  /** Every priced model in use this period, summed across all activities'
   * `byModel` entries (`spendUsd` + `tokens` added, `tier` kept from the
   * first fold), sorted `spendUsd` descending. Unpriced models are excluded
   * — never a fabricated $0 row. This is the surface-wide "spend by model"
   * driver view; `byModel` on each `ActivityRow` stays the per-activity cut. */
  spendByModel: ModelSpend[];
  /** The period's MEASURED total spend (`totals.spendUsd`, restricted to
   * priced models) split across the four token classes, plus a fifth
   * `unclassifiedUsd` bucket. Computed by `computeCostByType` via the
   * allocation-by-list-rate-weights algorithm — NOT a raw sum of
   * `priceTokens` class terms — so it reconciles to measured spend on BOTH
   * surfaces (Code, where measured spend equals the token-priced figure, and
   * Cowork, where it is the real `cost_usd`). `unclassifiedUsd` holds the
   * measured spend of any priced model whose token usage could not be
   * allocated (no usage row, e.g. Cowork's forward-only `token_usage`
   * persistence leaves pre-cutover months with no parsed usage; or a
   * zero-weight rate) — never dropped, so the five fields always sum to
   * `totals.spendUsd` for priced models on both surfaces. */
  costByType: { inputUsd: number; outputUsd: number; cacheWriteUsd: number; cacheReadUsd: number; unclassifiedUsd: number };
}

/**
 * Pure measured cache-efficiency helper: the share of input-side tokens that
 * were served from cache. Output tokens are deliberately EXCLUDED from the
 * denominator — cache reads only ever substitute for input-side tokens
 * (prompt/context), never for generation. `ratio` is `null` (never 0) when
 * there is no input-side token volume at all, so a genuinely-idle activity
 * reads as "no data" rather than a fabricated 0% efficiency.
 */
export function computeCacheEfficiency(u: TokenUsage): { ratio: number | null; cacheReadTokens: number; inputSideTokens: number } {
  const inputSideTokens = u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  const ratio = inputSideTokens > 0 ? u.cacheReadTokens / inputSideTokens : null;
  return { ratio, cacheReadTokens: u.cacheReadTokens, inputSideTokens };
}

// ─── Tuning constants (not admin-editable in v1 — calibrate against real
// demo data before final) ──────────────────────────────────────────
export const PREMIUM_SHARE_MIN = 0.4;
export const FRICTION_MAX = 0.15;
export const MIN_SESSIONS = 5;
export const MIN_SPEND = 25;

const UNCLASSIFIED_KEY = 'unclassified';
/** Cap on how many measured-breakdown entries (skill/subagent/effort, or
 * skill/connector for Cowork) surface per activity — top-N by spend. */
const MAX_MEASURED_BREAKDOWN = 5;

function labelFor(key: string): string {
  if (key === UNCLASSIFIED_KEY) return 'Unclassified';
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Shared opportunity-flag derivation — Code and Cowork (with
 * `checkFriction: false`) both call this. Neutral + data-driven: never
 * recommends, only flags a candidate for human review.
 *
 * `usageByModel` carries the activity's aggregated per-model token usage —
 * used ONLY for the estimate-ceiling math (`estimateCeilingUsd`/`priceTokens`),
 * which is necessarily per-token-class. `spendByModel` carries the activity's
 * MEASURED per-model spend (Code: this equals `priceTokens` since Code spend
 * IS the token-priced figure; Cowork: this is the real `SUM(cost_usd)` split)
 * and is what `premiumShare` is derived from, so the share's numerator and
 * denominator (`activity.totalSpendUsd`, itself measured) share the same cost
 * basis on both surfaces — never a list-repriced figure divided by a measured
 * total.
 */
export function deriveFlag(
  activity: { totalSpendUsd: number },
  ctx: { friction: number | null; sessionCount: number },
  modelsInUse: string[],
  usageByModel: Map<string, TokenUsage>,
  rates: ModelRates,
  opts: { checkFriction: boolean },
  spendByModel: Map<string, number>,
): OpportunityFlag | undefined {
  const ranked = rankModelsByPrice(modelsInUse, rates);
  if (ranked.length === 0) return undefined;

  const premiumModel = ranked[0];
  const premiumUsage = usageByModel.get(premiumModel);
  const totalSpend = activity.totalSpendUsd;
  const measuredPremiumSpend = spendByModel.get(premiumModel) ?? 0;
  const premiumShare = totalSpend > 0 ? Math.min(1, measuredPremiumSpend / totalSpend) : 0;

  // Minimum-volume guard — below floor, never flagged. Caller records this
  // activity in `belowVolume` instead.
  if (ctx.sessionCount < MIN_SESSIONS || totalSpend < MIN_SPEND) {
    return undefined;
  }

  if (premiumShare < PREMIUM_SHARE_MIN) {
    return undefined;
  }

  // High-friction activities are suppressed — a downgrade there likely
  // backfires. Flag object is present (so the UI can render it as
  // "suppressed") but carries no target/ceiling.
  if (opts.checkFriction && ctx.friction !== null && ctx.friction > FRICTION_MAX) {
    return {
      premiumModel,
      premiumShare,
      targetModel: null,
      estCeilingUsd: null,
      suppressedReason: 'high_friction',
    };
  }

  const targetModel = nextCheaperInUse(premiumModel, modelsInUse, rates);
  const estCeilingUsd = targetModel && premiumUsage
    ? estimateCeilingUsd(premiumUsage, premiumModel, targetModel, rates)
    : null;

  const flag: OpportunityFlag = { premiumModel, premiumShare, targetModel, estCeilingUsd };
  if (opts.checkFriction === false) flag.shareBasedOnly = true;
  return flag;
}

// ─── Code surface ────────────────────────────────────────────────────────────

interface CodeRow {
  session_id: string;
  work_type: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  skill_name: string | null;
  agent_name: string | null;
  effort: string | null;
}

interface ActivityAcc {
  key: string;
  label: string;
  totalSpendUsd: number;
  tokens: number;
  sessionIds: Set<string>;
  usageByModel: Map<string, TokenUsage>;
  spendByModel: Map<string, number>;
  tokensByModel: Map<string, number>;
  breakdown: Map<string, MeasuredBreakdownItem>;
}

function getOrCreateActivity(activities: Map<string, ActivityAcc>, key: string): ActivityAcc {
  let a = activities.get(key);
  if (!a) {
    a = {
      key,
      label: labelFor(key),
      totalSpendUsd: 0,
      tokens: 0,
      sessionIds: new Set(),
      usageByModel: new Map(),
      spendByModel: new Map(),
      tokensByModel: new Map(),
      breakdown: new Map(),
    };
    activities.set(key, a);
  }
  return a;
}

function addBreakdown(activity: ActivityAcc, dimension: string, key: string, spendUsd: number): void {
  const mapKey = `${dimension}:${key}`;
  const existing = activity.breakdown.get(mapKey);
  if (existing) existing.spendUsd += spendUsd;
  else activity.breakdown.set(mapKey, { dimension, key, spendUsd });
}

/** Count-based sibling of `addBreakdown` — see `MeasuredBreakdownItem.count`.
 * `spendUsd` stays 0 (never a count masquerading as dollars). */
function addBreakdownCount(activity: ActivityAcc, dimension: string, key: string, increment: number): void {
  const mapKey = `${dimension}:${key}`;
  const existing = activity.breakdown.get(mapKey);
  if (existing) existing.count = (existing.count ?? 0) + increment;
  else activity.breakdown.set(mapKey, { dimension, key, spendUsd: 0, count: increment });
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

function tokenTotal(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/** Sum every activity's already-aggregated per-model `TokenUsage` into one
 * surface-wide total — the input to `computeCacheEfficiency`. Shared by both
 * the Code and Cowork builders (`ActivityAcc` is the common accumulator
 * shape). */
function sumAllUsage(activities: Map<string, ActivityAcc>): TokenUsage {
  let total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const activity of activities.values()) {
    for (const usage of activity.usageByModel.values()) {
      total = sumUsage(total, usage);
    }
  }
  return total;
}

/** Fold every activity's already-aggregated per-model `TokenUsage` into one
 * surface-wide map, keyed by model — the per-model sibling of `sumAllUsage`.
 * Feeds `computeCostByType` (which needs one total `TokenUsage` per model,
 * not per activity, to derive each model's class weights). */
function foldUsageByModel(activities: Map<string, ActivityAcc>): Map<string, TokenUsage> {
  const total = new Map<string, TokenUsage>();
  for (const activity of activities.values()) {
    for (const [model, usage] of activity.usageByModel) {
      const existing = total.get(model);
      total.set(model, existing ? sumUsage(existing, usage) : usage);
    }
  }
  return total;
}

/** Fold every `ActivityRow.byModel` entry into one surface-wide
 * `Map<model, ModelSpend>` (summing `spendUsd` + `tokens`; `tier` is kept
 * from whichever activity is folded first — the field is cosmetic here,
 * ordering below is by `spendUsd` not `tier`), then sort `spendUsd`
 * descending. `byModel` is already priced-only (unpriced models never enter
 * it — see the Code/Cowork loops above), so `spendByModel` inherits that
 * exclusion for free; never a fabricated $0 row. */
function foldSpendByModel(activityRows: ActivityRow[]): ModelSpend[] {
  const map = new Map<string, ModelSpend>();
  for (const activity of activityRows) {
    for (const m of activity.byModel) {
      const existing = map.get(m.model);
      if (existing) {
        existing.spendUsd += m.spendUsd;
        existing.tokens += m.tokens;
      } else {
        map.set(m.model, { model: m.model, tier: m.tier, spendUsd: m.spendUsd, tokens: m.tokens });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.spendUsd - a.spendUsd);
}

/**
 * Split MEASURED per-model spend (`byModel[].spendUsd`) across the four
 * token classes by allocating each model's spend using that model's
 * LIST-RATE class weights (raw `priceTokens` class terms), never by summing
 * raw `priceTokens` terms directly as the class dollars.
 *
 * This is deliberate, not cosmetic: Code's `byModel.spendUsd` already equals
 * `Σ priceTokens` class terms (so allocation reproduces them exactly), but
 * Cowork's is the independently-measured `cost_usd` (which never equals the
 * list-rate `priceTokens` figure) — a raw-sum approach would silently fail
 * to reconcile to `totals.spendUsd` for Cowork. Allocating measured spend by
 * list-rate WEIGHTS (a ratio, not an absolute figure) reconciles for both:
 * `Σ costByType === Σ byModel.spendUsd` always, by construction.
 *
 * A model with no rate entry contributes nothing anywhere (a genuinely
 * unpriced model — real `byModel` inputs never contain one, since
 * `rankModelsByPrice` already filters those out; the guard exists so this
 * exported pure function stays defensive against a hand-built input).
 *
 * A PRICED model (has a rate, so its spend is real and counted in
 * `byModel`/`totals.spendUsd`) that has no usable per-model usage — no
 * `usageByModel` entry at all, or usage whose list-rate weight sums to zero
 * across all four classes (`denom <= 0`) — cannot be allocated to a token
 * class, but its spend must not be silently dropped (this is the gap fixed
 * here: Cowork's `token_usage` persistence is forward-only, so any
 * pre-cutover period has real `cost_usd` with no parsed usage at all). That
 * spend lands in `unclassifiedUsd` instead, so the reconciliation invariant
 * holds unconditionally: `inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd
 * + unclassifiedUsd === Σ(priced byModel.spendUsd)` for every input, not just
 * ones where every priced model happens to have usable usage.
 */
export function computeCostByType(
  byModel: ModelSpend[],
  usageByModel: Map<string, TokenUsage>,
  rates: ModelRates,
): { inputUsd: number; outputUsd: number; cacheWriteUsd: number; cacheReadUsd: number; unclassifiedUsd: number } {
  const costByType = { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, unclassifiedUsd: 0 };
  const M = 1_000_000;

  for (const m of byModel) {
    const r = rates[m.model] ?? rates[normalizeModelId(m.model)];
    if (!r) continue; // genuinely unpriced — contributes nothing anywhere

    const usage = usageByModel.get(m.model);
    if (!usage) {
      // Priced, but no usage row to derive class weights from — measured
      // spend still counts, just not attributable to a class.
      costByType.unclassifiedUsd += m.spendUsd;
      continue;
    }

    const raw = {
      input: (usage.inputTokens / M) * r.in,
      output: (usage.outputTokens / M) * r.out,
      cacheWrite: (usage.cacheCreationTokens / M) * r.cacheWrite,
      cacheRead: (usage.cacheReadTokens / M) * r.cacheRead,
    };
    const denom = raw.input + raw.output + raw.cacheWrite + raw.cacheRead;
    if (denom <= 0) {
      // Priced, usage present, but zero list-rate weight (e.g. an all-zero
      // rate) — still can't derive a class split; goes to unclassified
      // rather than being dropped.
      costByType.unclassifiedUsd += m.spendUsd;
      continue;
    }

    costByType.inputUsd += m.spendUsd * (raw.input / denom);
    costByType.outputUsd += m.spendUsd * (raw.output / denom);
    costByType.cacheWriteUsd += m.spendUsd * (raw.cacheWrite / denom);
    costByType.cacheReadUsd += m.spendUsd * (raw.cacheRead / denom);
  }

  return costByType;
}

async function buildCodeModelEfficiency(period: string): Promise<ModelEfficiencyReport> {
  const client = await getTypedClient();
  const { start, end } = monthBounds(period);
  const rates: ModelRates = await getCodeModelRates();

  const cam = schema.codeAssistantMeta;
  const csc = schema.codeSessionClassifications;
  const css = schema.codeSessionStats;

  const rows = (await client
    .select({
      session_id: cam.session_id,
      work_type: csc.work_type,
      model: cam.model,
      input_tokens: cam.input_tokens,
      output_tokens: cam.output_tokens,
      cache_creation_tokens: cam.cache_creation_tokens,
      cache_read_tokens: cam.cache_read_tokens,
      skill_name: cam.skill_name,
      agent_name: cam.agent_name,
      effort: cam.effort,
    })
    .from(cam)
    .leftJoin(csc, eq(csc.session_id, cam.session_id))
    .where(and(gte(cam.occurred_at, start), lt(cam.occurred_at, end)))) as CodeRow[];

  const unpricedModels = new Set<string>();
  const activities = new Map<string, ActivityAcc>();
  const codeLabel = await getCodeWorkTypeLabeller();

  for (const row of rows) {
    const key = row.work_type ?? UNCLASSIFIED_KEY;
    const activity = getOrCreateActivity(activities, key);
    if (key !== UNCLASSIFIED_KEY) activity.label = codeLabel(key);
    activity.sessionIds.add(row.session_id);

    if (!row.model) continue;

    const usage: TokenUsage = {
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheCreationTokens: Number(row.cache_creation_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
    };
    const cost = priceTokens(row.model, usage, rates);
    if (cost === null) {
      // Unpriced rows contribute NEITHER spend NOR a model-split entry —
      // never treated as $0. They only mark unpricedModels.
      unpricedModels.add(row.model);
      continue;
    }

    const rowTokens = tokenTotal(usage);
    activity.totalSpendUsd += cost;
    activity.tokens += rowTokens;
    activity.spendByModel.set(row.model, (activity.spendByModel.get(row.model) ?? 0) + cost);
    activity.tokensByModel.set(row.model, (activity.tokensByModel.get(row.model) ?? 0) + rowTokens);
    const existingUsage = activity.usageByModel.get(row.model);
    activity.usageByModel.set(row.model, existingUsage ? sumUsage(existingUsage, usage) : usage);

    if (row.skill_name) addBreakdown(activity, 'skill', row.skill_name, cost);
    if (row.agent_name) addBreakdown(activity, 'subagent', row.agent_name, cost);
    if (row.effort) addBreakdown(activity, 'effort', row.effort, cost);
  }

  // Friction per activity: SUM(error_count) / NULLIF(SUM(tool_use_count), 0)
  // from code_session_stats over the activity's sessions (0 when denom 0).
  const allSessionIds = Array.from(new Set(rows.map((r) => r.session_id)));
  const statsRows = allSessionIds.length
    ? await client
        .select({
          session_id: css.session_id,
          tool_use_count: css.tool_use_count,
          error_count: css.error_count,
        })
        .from(css)
        .where(inArray(css.session_id, allSessionIds))
    : [];
  const statsBySession = new Map<string, { tool_use_count: number; error_count: number }>();
  for (const s of statsRows) {
    statsBySession.set(s.session_id, {
      tool_use_count: Number(s.tool_use_count) || 0,
      error_count: Number(s.error_count) || 0,
    });
  }

  const activityRows: ActivityRow[] = [];
  const belowVolume: { key: string; label: string; totalSpendUsd: number }[] = [];
  let totalSpendUsd = 0;
  let totalTokens = 0;

  for (const activity of activities.values()) {
    totalSpendUsd += activity.totalSpendUsd;
    totalTokens += activity.tokens;

    let toolSum = 0;
    let errorSum = 0;
    for (const sid of activity.sessionIds) {
      const s = statsBySession.get(sid);
      if (s) {
        toolSum += s.tool_use_count;
        errorSum += s.error_count;
      }
    }
    const friction = toolSum > 0 ? errorSum / toolSum : 0;

    const modelsInUse = Array.from(activity.spendByModel.keys());
    const ranked = rankModelsByPrice(modelsInUse, rates);
    const byModel: ModelSpend[] = ranked.map((model, idx) => ({
      model,
      tier: idx + 1,
      spendUsd: activity.spendByModel.get(model) ?? 0,
      tokens: activity.tokensByModel.get(model) ?? 0,
    }));

    const measuredBreakdown = Array.from(activity.breakdown.values())
      .sort((a, b) => b.spendUsd - a.spendUsd)
      .slice(0, MAX_MEASURED_BREAKDOWN);

    const sessionCount = activity.sessionIds.size;
    const flag = deriveFlag(
      { totalSpendUsd: activity.totalSpendUsd },
      { friction, sessionCount },
      modelsInUse,
      activity.usageByModel,
      rates,
      { checkFriction: true },
      activity.spendByModel,
    );

    if (!flag && (sessionCount < MIN_SESSIONS || activity.totalSpendUsd < MIN_SPEND)) {
      belowVolume.push({ key: activity.key, label: activity.label, totalSpendUsd: activity.totalSpendUsd });
    }

    activityRows.push({
      key: activity.key,
      label: activity.label,
      judged: true,
      totalSpendUsd: activity.totalSpendUsd,
      tokens: activity.tokens,
      byModel,
      measuredBreakdown,
      friction,
      flag,
    });
  }

  activityRows.sort((a, b) => b.totalSpendUsd - a.totalSpendUsd);

  const allModelsInUse = new Set<string>();
  for (const activity of activities.values()) {
    for (const m of activity.spendByModel.keys()) allModelsInUse.add(m);
  }
  const modelOrder = rankModelsByPrice(Array.from(allModelsInUse), rates);
  const cacheEfficiency = computeCacheEfficiency(sumAllUsage(activities));
  const spendByModel = foldSpendByModel(activityRows);
  const costByType = computeCostByType(spendByModel, foldUsageByModel(activities), rates);

  return {
    surface: 'code',
    enabled: true,
    hasData: rows.length > 0,
    period: { start, end },
    totals: { spendUsd: totalSpendUsd, tokens: totalTokens },
    activities: activityRows,
    unpricedModels: Array.from(unpricedModels).sort(),
    belowVolume,
    modelOrder,
    cacheEfficiency,
    spendByModel,
    costByType,
  };
}

// ─── Cowork surface ──────────────────────────────────────────────────────────

interface CoworkSpendRow {
  session_id: string;
  model: string | null;
  /** `numeric` on Postgres reads back as a string (Policy B) — Number()'d below. */
  cost_usd: number | string | null;
  /** `jsonb` (pre-parsed by the driver) — normalise via jsonToText. */
  token_usage: unknown;
}

interface CoworkClassificationRow {
  session_id: string;
  task_type: string;
  /** bigint on Postgres reads back as a string (Policy B) — Number()'d below. */
  occurred_at: number | string;
}

/**
 * Parse a `cowork_messages.token_usage` value into a `TokenUsage`.
 *
 * The OTel receiver (`lib/otel/cowork-receiver.ts`, the `claude_code.api_request`
 * case) persists `JSON.stringify({ inputTokens, outputTokens, cacheReadTokens,
 * cacheCreationTokens })` — already camelCase, a 1:1 match for `TokenUsage`
 * (unlike Code's snake_case `code_assistant_meta` columns).
 *
 * `raw` must already be normalised to `string | null` via `jsonToText`.
 * Returns `null` (never zeros) when the value is absent, malformed,
 * or not a JSON object, so a caller can distinguish "no token data" from
 * "genuinely zero tokens" — this is what makes a flag's `estCeilingUsd`
 * fall back to `null` (concentration-only) rather than a fabricated figure.
 */
export function parseCoworkTokenUsage(raw: string | null): TokenUsage | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  return {
    inputTokens: Number(p.inputTokens) || 0,
    outputTokens: Number(p.outputTokens) || 0,
    cacheCreationTokens: Number(p.cacheCreationTokens) || 0,
    cacheReadTokens: Number(p.cacheReadTokens) || 0,
  };
}

/**
 * Task types that name the MECHANISM a session used rather than the work it
 * did — "work where an external connector (MCP tool) was invoked",
 * "specialised skill invoked as a load-bearing part of complex work". They are
 * real classifier outputs and stay in the taxonomy; they simply must not win a
 * session away from a label that says what the work WAS. See
 * buildSessionTaskTypeMap below for the measured effect.
 *
 * `autonomous_workflow` and `multi_file_operation` are deliberately NOT here —
 * they describe the shape of the work, not the tool that carried it out.
 */
export const MECHANISM_TASK_TYPES: ReadonlySet<string> = new Set([
  'connector_assisted',
  'connector_orchestration',
  'skill_assisted',
  'skill_invocation',
]);

/**
 * Build a session_id → task_type map from `pulse_classifications`.
 *
 * `pulse_classifications.cowork_message_id` points at the CLASSIFIED
 * `cowork_user_message` row (see `lib/pulse/classifier.ts` — it classifies
 * the user's prompt, never the API-request row that carries spend). Spend
 * lives on a DIFFERENT `cowork_messages` row (`message_type='cowork_api_request'`)
 * in the SAME session — so task_type attribution must join through
 * `cowork_messages` to read each classification's `session_id`, then
 * collapse a session's (possibly several) classifications to ONE task_type:
 * most-frequent wins; a tie breaks on whichever task_type's most recent
 * occurrence is newest. Sessions with no classification at all are absent
 * from the returned map (caller falls back to `UNCLASSIFIED_KEY`).
 *
 * EXPORTED so lib/pulse/cowork/session-output-rate.ts reuses this
 * exact collapse rather than growing a second copy of the most-frequent /
 * newest-tie-break logic.
 *
 * WORK-SHAPED LABELS WIN. Four labels in the Cowork
 * taxonomy describe the MECHANISM a session used rather than the work it did:
 * connector_assisted / connector_orchestration / skill_assisted /
 * skill_invocation are defined as "work where a connector (or skill) was
 * invoked". A long session tags those on every tool call, so most-frequent
 * handed them the session and buried what the work actually was. Measured
 * over 13 weeks: `analysis` appeared on 40 sessions and survived the
 * collapse on 2; `structured_report` 16 -> 1; `synthesis`, `capability_creation`
 * and `multi_file_operation` were wiped out entirely.
 *
 * So the collapse now runs most-frequent over WORK-SHAPED labels first, and
 * only falls back to a mechanism label when a session carries nothing else.
 * `autonomous_workflow` and `multi_file_operation` are NOT mechanism labels —
 * they describe the shape of the work, not the tool that did it.
 *
 * This changes FinOps Model Efficiency's activity axis as well as the session
 * output rate: spend that was really analysis had been filed under connector
 * work. Both surfaces now attribute it to the work.
 */
export async function buildSessionTaskTypeMap(
  client: Awaited<ReturnType<typeof getTypedClient>>,
  sessionIds: string[],
): Promise<Map<string, string>> {
  const sessionTaskType = new Map<string, string>();
  if (!sessionIds.length) return sessionTaskType;

  const cm = schema.coworkMessages;
  const pc = schema.pulseClassifications;

  const classRows = (await client
    .select({
      session_id: cm.session_id,
      task_type: pc.task_type,
      occurred_at: cm.occurred_at,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(inArray(cm.session_id, sessionIds))) as CoworkClassificationRow[];

  // Per session: count occurrences of each task_type, tracking the latest
  // occurred_at seen for that task_type (for the tie-break).
  const perSession = new Map<string, Map<string, { count: number; latest: number }>>();
  for (const r of classRows) {
    let bySessionMap = perSession.get(r.session_id);
    if (!bySessionMap) {
      bySessionMap = new Map();
      perSession.set(r.session_id, bySessionMap);
    }
    const entry = bySessionMap.get(r.task_type) ?? { count: 0, latest: -Infinity };
    entry.count += 1;
    const occurredAt = Number(r.occurred_at);
    if (occurredAt > entry.latest) entry.latest = occurredAt;
    bySessionMap.set(r.task_type, entry);
  }

  const pickBest = (
    byTaskType: Map<string, { count: number; latest: number }>,
    allow: (taskType: string) => boolean,
  ): string | null => {
    let bestTaskType: string | null = null;
    let best = { count: -1, latest: -Infinity };
    for (const [taskType, stats] of byTaskType) {
      if (!allow(taskType)) continue;
      const isBetter = stats.count > best.count
        || (stats.count === best.count && stats.latest > best.latest);
      if (isBetter) {
        best = stats;
        bestTaskType = taskType;
      }
    }
    return bestTaskType;
  };

  for (const [sessionId, byTaskType] of perSession) {
    // Work-shaped first; a mechanism label only when there is nothing else.
    const bestTaskType = pickBest(byTaskType, (t) => !MECHANISM_TASK_TYPES.has(t))
      ?? pickBest(byTaskType, () => true);
    if (bestTaskType !== null) sessionTaskType.set(sessionId, bestTaskType);
  }

  return sessionTaskType;
}

async function buildCoworkModelEfficiency(period: string): Promise<ModelEfficiencyReport> {
  const client = await getTypedClient();
  const { start, end } = monthBounds(period);
  const rates: ModelRates = await getCodeModelRates();

  const cm = schema.coworkMessages;

  const rows = (await client
    .select({
      session_id: cm.session_id,
      model: cm.model,
      cost_usd: cm.cost_usd,
      token_usage: cm.token_usage,
    })
    .from(cm)
    .where(and(
      eq(cm.message_type, 'cowork_api_request'),
      gte(cm.occurred_at, start),
      lt(cm.occurred_at, end),
    ))) as CoworkSpendRow[];

  const spendSessionIds = Array.from(new Set(rows.map((r) => r.session_id)));
  const sessionTaskType = await buildSessionTaskTypeMap(client, spendSessionIds);

  const activities = new Map<string, ActivityAcc>();

  for (const row of rows) {
    const key = sessionTaskType.get(row.session_id) ?? UNCLASSIFIED_KEY;
    const activity = getOrCreateActivity(activities, key);
    activity.sessionIds.add(row.session_id);

    // Measured spend: the stored cost_usd IS the real dollar figure — summed
    // unconditionally, regardless of whether tokens parsed or the model is
    // priced. Never re-derived via priceTokens (that would be parallel cost
    // math over an already-measured number).
    const cost = row.cost_usd !== null && row.cost_usd !== undefined ? Number(row.cost_usd) : null;
    const hasCost = cost !== null && !Number.isNaN(cost);
    if (hasCost) activity.totalSpendUsd += cost as number;

    if (!row.model) continue; // no model to attribute this row's split to

    if (hasCost) {
      activity.spendByModel.set(row.model, (activity.spendByModel.get(row.model) ?? 0) + (cost as number));
    }

    // Ceiling tokens ONLY — ignored for spend. A null/malformed parse simply
    // means this row contributes no tokens to its model's usage total; its
    // cost_usd has already been counted above.
    const usage = parseCoworkTokenUsage(jsonToText(row.token_usage));
    if (usage) {
      const rowTokens = tokenTotal(usage);
      activity.tokens += rowTokens;
      activity.tokensByModel.set(row.model, (activity.tokensByModel.get(row.model) ?? 0) + rowTokens);
      const existingUsage = activity.usageByModel.get(row.model);
      activity.usageByModel.set(row.model, existingUsage ? sumUsage(existingUsage, usage) : usage);
    }
  }

  // Measured drill-down: skill (cowork_skill_invocations) + connector
  // (cowork_mcp_invocations) invocations, attributed to every activity whose
  // session set includes the invocation's session_id. Neither table carries a
  // per-invocation dollar cost (Cowork prices at the api_request level, not
  // per tool call), so these populate `MeasuredBreakdownItem.count` (an
  // INVOCATION COUNT) via `addBreakdownCount` — `spendUsd` stays 0, never a
  // count masquerading as dollars.
  const allSessionIds = Array.from(new Set(rows.map((r) => r.session_id)));
  const sessionToActivityKeys = new Map<string, string[]>();
  for (const activity of activities.values()) {
    for (const sid of activity.sessionIds) {
      const arr = sessionToActivityKeys.get(sid);
      if (arr) arr.push(activity.key);
      else sessionToActivityKeys.set(sid, [activity.key]);
    }
  }

  if (allSessionIds.length) {
    const csi = schema.coworkSkillInvocations;
    const skillRows = await client
      .select({ session_id: csi.session_id, skill_name: csi.skill_name })
      .from(csi)
      .where(inArray(csi.session_id, allSessionIds));
    for (const r of skillRows) {
      for (const activityKey of sessionToActivityKeys.get(r.session_id) ?? []) {
        addBreakdownCount(activities.get(activityKey)!, 'skill', r.skill_name, 1);
      }
    }

    const cmi = schema.coworkMcpInvocations;
    const connectorRows = await client
      .select({ session_id: cmi.session_id, mcp_server: cmi.mcp_server })
      .from(cmi)
      .where(inArray(cmi.session_id, allSessionIds));
    for (const r of connectorRows) {
      for (const activityKey of sessionToActivityKeys.get(r.session_id) ?? []) {
        addBreakdownCount(activities.get(activityKey)!, 'connector', r.mcp_server, 1);
      }
    }
  }

  const activityRows: ActivityRow[] = [];
  const belowVolume: { key: string; label: string; totalSpendUsd: number }[] = [];
  const unpricedModels = new Set<string>();
  let totalSpendUsd = 0;
  let totalTokens = 0;

  for (const activity of activities.values()) {
    totalSpendUsd += activity.totalSpendUsd;
    totalTokens += activity.tokens;

    const modelsInUse = Array.from(activity.spendByModel.keys());
    const ranked = rankModelsByPrice(modelsInUse, rates);
    // Any model with real measured spend that rankModelsByPrice dropped has
    // no rate entry — surfaced in unpricedModels (never silently $0, and
    // unlike Code, its ALREADY-measured spend still counts toward totals;
    // it just can't participate in tiering/the ceiling estimate).
    for (const m of modelsInUse) {
      if (!ranked.includes(m)) unpricedModels.add(m);
    }

    const byModel: ModelSpend[] = ranked.map((model, idx) => ({
      model,
      tier: idx + 1,
      spendUsd: activity.spendByModel.get(model) ?? 0,
      tokens: activity.tokensByModel.get(model) ?? 0,
    }));

    // Cowork's drill-down entries carry `count`, not `spendUsd` (always 0
    // here) — rank by count instead.
    const measuredBreakdown = Array.from(activity.breakdown.values())
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, MAX_MEASURED_BREAKDOWN);

    const sessionCount = activity.sessionIds.size;
    // Cowork never measures friction (no tool-error signal at this level) —
    // deriveFlag is called with checkFriction:false, which both skips the
    // high_friction suppression branch entirely and sets shareBasedOnly:true.
    const flag = deriveFlag(
      { totalSpendUsd: activity.totalSpendUsd },
      { friction: null, sessionCount },
      modelsInUse,
      activity.usageByModel,
      rates,
      { checkFriction: false },
      activity.spendByModel,
    );

    if (!flag && (sessionCount < MIN_SESSIONS || activity.totalSpendUsd < MIN_SPEND)) {
      belowVolume.push({ key: activity.key, label: activity.label, totalSpendUsd: activity.totalSpendUsd });
    }

    activityRows.push({
      key: activity.key,
      label: activity.label,
      judged: true,
      totalSpendUsd: activity.totalSpendUsd,
      tokens: activity.tokens,
      byModel,
      measuredBreakdown,
      friction: null,
      flag,
    });
  }

  activityRows.sort((a, b) => b.totalSpendUsd - a.totalSpendUsd);

  const allModelsInUse = new Set<string>();
  for (const activity of activities.values()) {
    for (const m of activity.spendByModel.keys()) allModelsInUse.add(m);
  }
  const modelOrder = rankModelsByPrice(Array.from(allModelsInUse), rates);
  const cacheEfficiency = computeCacheEfficiency(sumAllUsage(activities));
  const spendByModel = foldSpendByModel(activityRows);
  const costByType = computeCostByType(spendByModel, foldUsageByModel(activities), rates);

  return {
    surface: 'cowork',
    enabled: true,
    hasData: rows.length > 0,
    period: { start, end },
    totals: { spendUsd: totalSpendUsd, tokens: totalTokens },
    activities: activityRows,
    unpricedModels: Array.from(unpricedModels).sort(),
    belowVolume,
    modelOrder,
    cacheEfficiency,
    spendByModel,
    costByType,
  };
}

/**
 * Build a Model Efficiency report for one surface + calendar-month period.
 * `nowS` is accepted for parity with the Cowork branch / future callers
 * (e.g. month-to-date framing) but the Code path doesn't need it today.
 */
export async function buildModelEfficiency(
  surface: Surface,
  period: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<ModelEfficiencyReport> {
  void nowS;
  if (surface === 'cowork') {
    return buildCoworkModelEfficiency(period);
  }
  return buildCodeModelEfficiency(period);
}

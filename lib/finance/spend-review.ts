// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Spend Review — one person's AI spend for a calendar month, by kind of work,
 * with what it produced and a better route where colleagues show one.
 *
 * Three questions, in this order:
 *   1. What is the money going on?  Spend by kind of work (Code + Cowork).
 *   2. Is it producing anything?    Output rate (Cowork) / commits (Code), depth.
 *   3. Is there a better route?     Skills and connectors colleagues use for the
 *                                   same kind of work, and a cheaper model where
 *                                   colleagues mostly use one.
 *
 * Spend reuses the FinOps primitives exactly (Code: `code_assistant_meta`
 * tokens priced with `priceTokens`; Cowork: the stored `cost_usd` on
 * `cowork_api_request` rows), so a person's month total here equals their
 * chargeback figure. An unpriced Code model is named, never priced at $0.
 *
 * The kind of work is AI-judged (Cowork per-message classifier collapsed per
 * session by `buildSessionTaskTypeMap`; Code session classifier `work_type`).
 * The month aligns with Anthropic's monthly spend-limit period (UTC calendar
 * month), so the review can sit beside the person's limit.
 *
 * Colleague comparisons use the trailing PEER_WINDOW_DAYS ending at the
 * review's end (or now), never the person's own sessions, and only show when
 * at least MIN_PEER_USERS other people did the same kind of work, so no figure
 * can be traced to one colleague. Colleagues are never named.
 */
import { and, eq, gte, inArray, lt, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { jsonToText } from '@/lib/db/json';
import { monthBounds } from '@/lib/finance/period';
import { getCodeModelRates, priceTokens, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';
import { rankModelsByPrice, estimateCeilingUsd, modelPrice } from '@/lib/finance/model-tiering';
import { normalizeModelId } from '@/lib/pulse/code/rates';
import { isBuiltInTool } from '@/lib/finance/spend-review-builtins';
import { buildSessionTaskTypeMap, parseCoworkTokenUsage, computeCostByType, computeCacheEfficiency, type ModelSpend } from '@/lib/finance/model-efficiency';
import { formatTaskType } from '@/lib/pulse/events/capability';
import { codeWorkTypeLabel, codeWorkTypeDefinition } from '@/lib/pulse/code/work-type-labels';
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { buildChargeback } from '@/lib/finance/chargeback';
import { SpendSplitAcc, type SpendSplit } from '@/lib/finance/where-money-went';

export const PEER_WINDOW_DAYS = 90;
export const MIN_PEER_USERS = 3;
export const MIN_PEER_SESSIONS = 5;
export const MAX_TOOL_ROUTES = 3;
/** A skill or connector route needs colleagues to use it in at least this share of their sessions of that work. */
export const MIN_TOOL_SESSION_SHARE = 0.1;
/** Routes are only offered on work that is at least this share of the person's spend. */
export const MIN_WORK_SHARE_FOR_ROUTES = 0.1;
export const MAX_SESSIONS_LISTED = 50;
const MAX_OUTPUTS_PER_SESSION = 5;
const CHUNK = 1000;

type Client = Awaited<ReturnType<typeof getTypedClient>>;
export type ReviewSurface = 'code' | 'cowork';
export type { SpendSplit } from './where-money-went';

export interface ReviewSession {
  surface: ReviewSurface;
  sessionId: string;
  startedAt: number | null;
  /** Last event of the session (it may run on past this month, or have started before it). */
  endedAt: number | null;
  /** The scheduled task that started this session, if one did. */
  scheduledTask: string | null;
  workKey: string | null;
  workLabel: string | null;
  tier: number | null;
  activeSecs: number | null;
  prompts: number | null;
  actions: number | null;
  /** Priced spend this month; null when nothing in the session could be priced. */
  spendUsd: number | null;
  /** True when part of the session ran on a model with no rate. */
  hasUnpriced: boolean;
  models: string[];
  skills: string[];
  connectors: string[];
  /** Subagents that made model calls in this session this month. */
  subagents: string[];
  outputs: string[];
  commits: number | null;
  /** Cowork only: produced a file or artifact. Null = not measured. */
  producedOutput: boolean | null;
}

export type ReviewRoute =
  | { kind: 'tool'; toolType: 'skill' | 'connector'; name: string; peerUsers: number; peerSessionShare: number; libraryEntryId: number | null }
  | ModelAdvice
  | ContextAdvice;

export interface WorkRow {
  key: string;
  surface: ReviewSurface;
  workKey: string | null;
  label: string;
  /** The classifier's definition of this kind of work (Code), shown beside the label. */
  definition: string | null;
  spendUsd: number;
  share: number;
  sessions: number;
  /** Active time across this work's sessions (whole sessions, not just this month); null when none was measured. */
  activeSecs: number | null;
  /** First start and last event across this work's sessions, so a session running for days reads as such. */
  firstAt: number | null;
  lastAt: number | null;
  /** Median priced spend per session. */
  typicalSessionUsd: number | null;
  peer: { users: number; sessions: number; typicalSessionUsd: number | null } | null;
  produced: { measured: number; produced: number } | null;
  commits: number | null;
  deepSessions: number;
  topModel: { model: string; share: number } | null;
  routes: ReviewRoute[];
  /** Models colleagues use for this work beside the person's own figures. Empty when too few colleagues. */
  models: ModelFitRow[];
  /** Where this work's money went: main conversation vs subagents, by subagent and by skill. */
  split: SpendSplit;
}

export interface ScheduledTask {
  name: string;
  surface: ReviewSurface;
  /** Sessions this month, and the distinct UTC days they ran on. */
  runs: number;
  days: number;
  spendUsd: number;
  /** The model that carried most of the cost; null when nothing was priced. */
  mainModel: string | null;
  /** Share of the spend on models where a Sonnet or Haiku model costs at most 60% of the price per token. */
  costlyShare: number;
  /** The biggest of those costly models, named in the suggestion. */
  costlyModel: string | null;
  /** Cheaper families worth trying (e.g. ["Sonnet", "Haiku"]); empty = no suggestion. */
  cheaperFamilies: string[];
}

export interface SpendReview {
  userId: string;
  displayName: string;
  email: string | null;
  department: string | null;
  period: string;
  periodStart: number;
  periodEnd: number;
  totals: { totalUsd: number; codeUsd: number; coworkUsd: number; sessions: number };
  unpricedModels: string[];
  work: WorkRow[];
  sessions: ReviewSession[];
  sessionsTotal: number;
  /** Scheduled tasks (sessions opened by `<scheduled-task name="...">`) this month, biggest spend first. */
  scheduledTasks: ScheduledTask[];
  peerWindowDays: number;
  /** The FinOps cost drivers for this person's month, from the same functions FinOps uses. */
  modelEfficiency: {
    modelOrder: string[];
    spendByModel: ModelSpend[];
    costByType: ReturnType<typeof computeCostByType>;
    cacheEfficiency: ReturnType<typeof computeCacheEfficiency>;
  };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** One kind of work's split, merged from its sessions. */
function mergeSplits(accs: SessionAcc[]): SpendSplit {
  const all = new SpendSplitAcc();
  for (const a of accs) all.merge(a.split);
  return all.result();
}

export function median(values: number[]): number | null {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The rubric's definition of each Code kind of work, as configured now. */
type CodeDefs = Map<string, string>;

function loadCodeDefs(): Promise<CodeDefs> {
  return getCodeWorkTypeDefinitions();
}

export function workLabel(surface: ReviewSurface, workKey: string | null, codeDefs?: CodeDefs): string {
  if (!workKey) return 'Not classified yet';
  return surface === 'code' ? codeWorkTypeLabel(workKey, codeDefs?.get(workKey)) : formatTaskType(workKey);
}

/** What the classifier was told a kind of work covers (Code only; the Cowork labels carry their own meaning). */
function workDefinition(surface: ReviewSurface, workKey: string | null, codeDefs?: CodeDefs): string | null {
  return surface === 'code' && workKey ? codeWorkTypeDefinition(workKey, codeDefs?.get(workKey)) : null;
}

function addUsage(map: Map<string, TokenUsage>, model: string, u: TokenUsage): void {
  const e = map.get(model);
  map.set(model, e
    ? { inputTokens: e.inputTokens + u.inputTokens, outputTokens: e.outputTokens + u.outputTokens, cacheCreationTokens: e.cacheCreationTokens + u.cacheCreationTokens, cacheReadTokens: e.cacheReadTokens + u.cacheReadTokens }
    : { ...u });
}

function addNum(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

/** Running figures for one model on one kind of work. */
export interface ModelTally {
  people: Set<string>;
  sessions: number;
  spends: number[];
  /** Cowork sessions whose output was measured / that produced a file. */
  measured: number;
  produced: number;
  /** Sessions with a tier / at Tier 3. */
  tiered: number;
  deep: number;
}

export function newTally(): ModelTally {
  return { people: new Set(), sessions: 0, spends: [], measured: 0, produced: 0, tiered: 0, deep: 0 };
}

/** One session into a tally. `mainModel` is the model that carried most of its spend. */
export function tallySession(t: ModelTally, s: { userId: string; spend: number | null; produced: boolean | null; tier: number | null }): void {
  t.people.add(s.userId);
  t.sessions += 1;
  if (s.spend !== null) t.spends.push(s.spend);
  if (s.produced !== null) { t.measured += 1; if (s.produced) t.produced += 1; }
  if (s.tier !== null) { t.tiered += 1; if (s.tier >= 3) t.deep += 1; }
}

export function mergeTally(into: ModelTally, from: ModelTally): void {
  for (const p of from.people) into.people.add(p);
  into.sessions += from.sessions;
  into.spends.push(...from.spends);
  into.measured += from.measured;
  into.produced += from.produced;
  into.tiered += from.tiered;
  into.deep += from.deep;
}

/** The model that carried most of a session's priced spend. */
export function mainModel(spendByModel: Map<string, number>): string | null {
  let best: string | null = null;
  let max = -1;
  for (const [m, v] of spendByModel) if (v > max) { max = v; best = m; }
  return best;
}

/** Below this many sessions with a measured outcome, a rate is not shown or compared. */
export const MIN_OUTCOME_SESSIONS = 5;
/** A cheaper model must cost at most this share of the current one per token (list price)... */
export const SAVE_MAX_COST_RATIO = 0.6;
/** A suggested model needs at least this many colleague sessions of the work behind it. */
export const MIN_ADVICE_SESSIONS = 20;
/** ...and its outcome rate may be at most this much lower. */
export const SAVE_MAX_OUTCOME_DROP = 0.1;
/** A dearer model must beat the current one's outcome rate by at least this much... */
export const STEP_UP_MIN_OUTCOME_GAIN = 0.15;
/** ...and cost at least this many times as much per token: a bigger model, not a sibling or an older one. */
export const STEP_UP_MIN_PRICE_RATIO = 1.5;
/** A save is worth suggesting at this much this month... */
export const MIN_SAVE_USD = 5;
/** ...or at this share of what the person spends on the work (early in a month the dollars are small)... */
export const MIN_SAVE_SHARE = 0.2;
/** The long-conversation line needs re-reading to be at least this share of the work's cost... */
export const REREAD_SHARE_MIN = 0.4;
/** ...and at least this much above colleagues' share for the same work (re-reading is the norm in Cowork). */
export const REREAD_ABOVE_PEERS = 0.15;
/** ...but never below this: trivial sums are not advice. */
export const MIN_SAVE_FLOOR_USD = 1;

export function savingWorthIt(saving: number | null, workSpendUsd: number | null): boolean {
  if (saving === null || saving < MIN_SAVE_FLOOR_USD) return false;
  return saving >= MIN_SAVE_USD || (workSpendUsd !== null && workSpendUsd > 0 && saving >= workSpendUsd * MIN_SAVE_SHARE);
}

export interface ModelFigures {
  sessions: number;
  people: number;
  typicalSessionUsd: number | null;
  /** Share of sessions that produced a file (Cowork). Null below MIN_OUTCOME_SESSIONS measured. */
  producedRate: number | null;
  /** Share of sessions at Tier 3. Null below MIN_OUTCOME_SESSIONS tiered. */
  deepRate: number | null;
}

export function figures(t: ModelTally): ModelFigures {
  return {
    sessions: t.sessions,
    people: t.people.size,
    typicalSessionUsd: median(t.spends),
    producedRate: t.measured >= MIN_OUTCOME_SESSIONS ? t.produced / t.measured : null,
    deepRate: t.tiered >= MIN_OUTCOME_SESSIONS ? t.deep / t.tiered : null,
  };
}

export interface ModelFitRow {
  model: string;
  /** This person's spend on the model for this work this month, and its share of that work's spend. Null = used but not priced. */
  spendUsd: number | null;
  spendShare: number;
  you: ModelFigures | null;
  /** Null when fewer than MIN_PEER_USERS colleagues or MIN_PEER_SESSIONS sessions used it for this work. */
  colleagues: ModelFigures | null;
}

export type ModelAdvice = {
  kind: 'model';
  /** save / step_up: colleagues' sessions back it. trial: much cheaper, but too few colleagues use it for this work to show results. */
  direction: 'save' | 'step_up' | 'trial';
  fromModel: string;
  toModel: string;
  /** Which outcome the comparison used; null = outcomes could not be compared for this work. */
  metric: 'produced' | 'deep' | null;
  from: { typicalSessionUsd: number | null; rate: number | null; basis: 'colleagues' | 'you' };
  to: { typicalSessionUsd: number | null; rate: number | null; people: number; sessions: number };
  /** Ceiling: this month's sessions on fromModel repriced to toModel. Save and trial. */
  estSavingUsd: number | null;
  /** toModel's list price per token as a share of fromModel's (0.25 = a quarter). */
  priceRatio: number;
  /** estSavingUsd as a share of the person's spend on this work (null when unknown). */
  savingShare: number | null;
};

/** Long conversations: most of the cost is re-reading earlier conversation (cache reads), which no model choice removes. */
export type ContextAdvice = { kind: 'context'; rereadShare: number; peerRereadShare: number };

function outcomeRate(f: ModelFigures, metric: 'produced' | 'deep'): number | null {
  return metric === 'produced' ? f.producedRate : f.deepRate;
}

/**
 * Model fit for one kind of work: each model colleagues use for it (enough of
 * them to compare) beside the person's own figures, and at most one piece of
 * advice. CCC does not measure answer quality, so the advice compares what
 * colleagues' sessions on each model cost and how often they produced a file
 * (Cowork) or reached Tier 3 — never that a model is "better".
 *
 *  - save:    a model colleagues use for this work (MIN_ADVICE_SESSIONS+
 *             sessions) costs at most SAVE_MAX_COST_RATIO as much per token,
 *             with an outcome rate no more than SAVE_MAX_OUTCOME_DROP lower
 *             (or none to compare) and MIN_SAVE_USD+ saved on own usage.
 *  - step_up: a model colleagues use (MIN_ADVICE_SESSIONS+ sessions) costs
 *             STEP_UP_MIN_PRICE_RATIO+ per token and reaches the outcome at
 *             least STEP_UP_MIN_OUTCOME_GAIN more often.
 *  - trial:   neither, but a much cheaper model exists that too few
 *             colleagues use for this work to show results; price alone.
 *
 * Per-token list price, not cost per session, decides cheaper/dearer:
 * session size differs between people (Sonnet 5 at
 * half Opus 5.5's price looked dearer per session). The evidence floor stops
 * a handful of sessions outweighing many (Fable 5.1's 5 sessions against
 * Opus 5.5's 53).
 *
 * The person's current model is the one most of their sessions of this work
 * ran on. Its baseline is colleagues' figures on it when there are enough,
 * else the person's own.
 */
export function deriveModelFit(
  surface: ReviewSurface,
  you: Map<string, ModelTally>,
  colleagues: Map<string, ModelTally>,
  personUsageByModel: Map<string, TokenUsage>,
  rates: ModelRates,
  /** The person's spend on this kind of work this month, for the share-based saving floor. */
  workSpendUsd: number | null = null,
): { rows: ModelFitRow[]; advice: ModelAdvice | null; trial: ModelAdvice | null } {
  const qualifies = (t: ModelTally | undefined) => !!t && t.people.size >= MIN_PEER_USERS && t.sessions >= MIN_PEER_SESSIONS;
  const models = new Set<string>([...you.keys(), ...[...colleagues.entries()].filter(([, t]) => qualifies(t)).map(([m]) => m)]);
  const ordered = rankModelsByPrice([...models], rates);
  for (const m of models) if (!ordered.includes(m)) ordered.push(m); // unpriced last
  const rows: ModelFitRow[] = ordered.map(model => ({
    model,
    spendUsd: 0,
    spendShare: 0,
    you: you.has(model) ? figures(you.get(model)!) : null,
    colleagues: qualifies(colleagues.get(model)) ? figures(colleagues.get(model)!) : null,
  }));

  const current = [...you.entries()].sort((a, b) => b[1].sessions - a[1].sessions)[0]?.[0];
  // No advice from an unpriced current model: its cost cannot be compared.
  if (!current || rankModelsByPrice([current], rates).length === 0) return { rows, advice: null, trial: null };
  const baseRow = rows.find(r => r.model === current)!;
  // Colleagues' figures for the current model only when there are enough of them; else the person's own.
  const baseColleagues = baseRow.colleagues && (colleagues.get(current)?.sessions ?? 0) >= MIN_ADVICE_SESSIONS ? baseRow.colleagues : null;
  const base = baseColleagues ?? baseRow.you!;
  const basis: 'colleagues' | 'you' = baseColleagues ? 'colleagues' : 'you';
  const preferred: Array<'produced' | 'deep'> = surface === 'cowork' ? ['produced', 'deep'] : ['deep'];

  const price = (m: string) => { const r = rates[m] ?? rates[normalizeModelId(m)]; return r ? modelPrice(r) : null; };
  const currentPrice = price(current)!;
  // Enough colleague sessions of this work on a model to trust its outcome figures.
  const evidenced = (m: string) => (colleagues.get(m)?.sessions ?? 0) >= MIN_ADVICE_SESSIONS;
  const candidates = rows.filter(r => r.model !== current && r.colleagues && price(r.model) !== null && evidenced(r.model));
  const usage = personUsageByModel.get(current);
  const savingTo = (m: string) => usage ? estimateCeilingUsd(usage, current, m, rates) : null;
  const sessionsOn = (m: string) => colleagues.get(m)?.sessions ?? 0;

  const savingShare = (v: number | null) => (v !== null && workSpendUsd && workSpendUsd > 0 ? v / workSpendUsd : null);

  // Save: clearly cheaper per token (list price, so session size does not
  // decide it), outcomes no more than SAVE_MAX_OUTCOME_DROP worse, worth it on
  // this person's own usage. Biggest saving first.
  const cheaper = candidates
    .filter(r => price(r.model)! <= currentPrice * SAVE_MAX_COST_RATIO)
    .map(r => ({ r, saving: savingTo(r.model) }))
    .sort((x, y) => (y.saving ?? 0) - (x.saving ?? 0));
  // The cheapest evidenced cheaper model whose results hold up, worth suggesting or not:
  // an untested trial must be a genuinely bigger step than this.
  let provenCheapestPrice: number | null = null;
  let save: ModelAdvice | null = null;
  for (const { r, saving } of cheaper) {
    // An outcome only compares when at least one side reached it: 0% against 0% says nothing.
    const metric = preferred.find(m => {
      const x = outcomeRate(base, m);
      const y = outcomeRate(r.colleagues!, m);
      return x !== null && y !== null && (x > 0 || y > 0);
    }) ?? null;
    if (metric && outcomeRate(r.colleagues!, metric)! < outcomeRate(base, metric)! - SAVE_MAX_OUTCOME_DROP) continue;
    provenCheapestPrice = Math.min(provenCheapestPrice ?? Infinity, price(r.model)!);
    if (save || !savingWorthIt(saving, workSpendUsd)) continue;
    save = {
      kind: 'model', direction: 'save', fromModel: current, toModel: r.model, metric,
      from: { typicalSessionUsd: base.typicalSessionUsd, rate: metric ? outcomeRate(base, metric) : null, basis },
      to: { typicalSessionUsd: r.colleagues!.typicalSessionUsd, rate: metric ? outcomeRate(r.colleagues!, metric) : null, people: r.colleagues!.people, sessions: sessionsOn(r.model) },
      estSavingUsd: saving, priceRatio: price(r.model)! / currentPrice, savingShare: savingShare(saving),
    };
  }

  // Step up (only when there is no save): clearly dearer per token, outcomes clearly better.
  let step: ModelAdvice | null = null;
  for (const metric of save ? [] : preferred) {
    const baseRate = outcomeRate(base, metric);
    if (baseRate === null) continue;
    const better = candidates
      .filter(r => price(r.model)! >= currentPrice * STEP_UP_MIN_PRICE_RATIO)
      .filter(r => (outcomeRate(r.colleagues!, metric) ?? -1) >= baseRate + STEP_UP_MIN_OUTCOME_GAIN)
      .sort((a, b) => outcomeRate(b.colleagues!, metric)! - outcomeRate(a.colleagues!, metric)!);
    if (better.length) {
      const r = better[0];
      step = {
        kind: 'model', direction: 'step_up', fromModel: current, toModel: r.model, metric,
        from: { typicalSessionUsd: base.typicalSessionUsd, rate: baseRate, basis },
        to: { typicalSessionUsd: r.colleagues!.typicalSessionUsd, rate: outcomeRate(r.colleagues!, metric), people: r.colleagues!.people, sessions: sessionsOn(r.model) },
        estSavingUsd: null, priceRatio: price(r.model)! / currentPrice, savingShare: null,
      };
      break;
    }
  }

  // Trial: a much cheaper model too few colleagues use for this work to show results.
  // Price alone, clearly labelled. Only when nothing cheaper is proven (a proven save is
  // the advice; a trial beside it would be a riskier copy) and never beside a step up.
  let trial: ModelAdvice | null = null;
  if (!step && provenCheapestPrice === null) {
    const cap = currentPrice * SAVE_MAX_COST_RATIO;
    const pick = Object.keys(rates)
      .filter(m => m.startsWith('claude-') && (price(m) ?? 0) > 0 && !evidenced(m) && m !== current)
      .filter(m => price(m)! <= cap)
      .map(m => ({ m, saving: savingTo(m), used: colleagues.has(m) || you.has(m) }))
      .filter(x => savingWorthIt(x.saving, workSpendUsd))
      .sort((x, y) => price(x.m)! - price(y.m)! || Number(y.used) - Number(x.used) || x.m.length - y.m.length)[0];
    if (pick) {
      trial = {
        kind: 'model', direction: 'trial', fromModel: current, toModel: pick.m, metric: null,
        from: { typicalSessionUsd: base.typicalSessionUsd, rate: null, basis },
        to: { typicalSessionUsd: null, rate: null, people: colleagues.get(pick.m)?.people.size ?? 0, sessions: sessionsOn(pick.m) },
        estSavingUsd: pick.saving, priceRatio: price(pick.m)! / currentPrice, savingShare: savingShare(pick.saving),
      };
    }
  }
  return { rows, advice: save ?? step, trial };
}

/** Share of a usage mix's list-price cost that is re-reading earlier conversation (cache reads). Null with no priced usage. */
export function rereadShare(usageByModel: Map<string, TokenUsage>, rates: ModelRates): number | null {
  let reread = 0;
  let total = 0;
  for (const [m, u] of usageByModel) {
    const r = rates[m] ?? rates[normalizeModelId(m)];
    if (!r) continue;
    reread += u.cacheReadTokens * r.cacheRead;
    total += u.inputTokens * r.in + u.outputTokens * r.out + u.cacheCreationTokens * r.cacheWrite + u.cacheReadTokens * r.cacheRead;
  }
  return total > 0 ? reread / total : null;
}

/**
 * The long-conversation line: when re-reading earlier conversation is at least
 * REREAD_SHARE_MIN of this work's cost AND at least REREAD_ABOVE_PEERS above
 * colleagues' share for the same work. Re-reading is how Cowork works (41-74%
 * for most people), so only an outlier is advice.
 */
export function contextAdvice(person: Map<string, TokenUsage>, peers: Map<string, TokenUsage> | null, rates: ModelRates): ContextAdvice | null {
  const mine = rereadShare(person, rates);
  const theirs = peers ? rereadShare(peers, rates) : null;
  if (mine === null || theirs === null) return null;
  return mine >= REREAD_SHARE_MIN && mine >= theirs + REREAD_ABOVE_PEERS ? { kind: 'context', rereadShare: mine, peerRereadShare: theirs } : null;
}

/**
 * Adds the person's spend per model to the fit rows (including a model that
 * carried part of a session but was never its main model), ordered by that
 * spend, with models only colleagues used last.
 */
export function withPersonSpend(rows: ModelFitRow[], spendByModel: Map<string, number>, workSpend: number, unpricedModels: Set<string> = new Set()): ModelFitRow[] {
  const out = rows.map(r => ({ ...r }));
  for (const m of [...spendByModel.keys(), ...unpricedModels]) {
    if (!out.some(r => r.model === m)) out.push({ model: m, spendUsd: 0, spendShare: 0, you: null, colleagues: null });
  }
  for (const r of out) {
    const v = spendByModel.get(r.model);
    // Used but never priced: say so, never $0.
    r.spendUsd = v === undefined && unpricedModels.has(r.model) ? null : v ?? 0;
    r.spendShare = workSpend > 0 && r.spendUsd !== null ? r.spendUsd / workSpend : 0;
  }
  return out.sort((a, b) => (b.spendUsd ?? -1) - (a.spendUsd ?? -1));
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function chunks<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

async function inChunks<T, R>(ids: T[], fn: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(ids)) out.push(...(await fn(part)));
  return out;
}

/** A name or department, or null when blank: an empty admin_users value must not hide the users row's. */
function filled(v: string | null | undefined): string | null {
  return v && v.trim() ? v : null;
}

export async function resolvePerson(client: Client, userId: string): Promise<{ displayName: string; email: string | null; department: string | null }> {
  const u = schema.users;
  const au = schema.adminUsers;
  const userRows = await client.select({ email: u.email, display_name: u.display_name, department: u.department }).from(u).where(eq(u.id, userId)).limit(1);
  const adminRows = await client.select({ display_name: au.display_name, department: au.department }).from(au).where(eq(au.linked_cowork_user_id, userId)).limit(1);
  const email = userRows[0]?.email ?? null;
  return {
    displayName: filled(adminRows[0]?.display_name) ?? filled(userRows[0]?.display_name) ?? email ?? userId,
    email,
    department: filled(adminRows[0]?.department) ?? filled(userRows[0]?.department),
  };
}

interface SessionAcc {
  surface: ReviewSurface;
  sessionId: string;
  userId: string;
  spend: number;
  priced: boolean;
  hasUnpriced: boolean;
  /** Models in the session with no price (Code only). */
  unpricedModels: Set<string>;
  spendByModel: Map<string, number>;
  usageByModel: Map<string, TokenUsage>;
  /** Filled only for the person under review (not the colleague population). */
  split: SpendSplitAcc;
  subagents: Set<string>;
}

type SessionFilter = { all: true } | { userId: string } | { sessionIds: string[] };

function newAcc(surface: ReviewSurface, sessionId: string, userId: string): SessionAcc {
  return { surface, sessionId, userId, spend: 0, priced: false, hasUnpriced: false, unpricedModels: new Set(), spendByModel: new Map(), usageByModel: new Map(), split: new SpendSplitAcc(), subagents: new Set() };
}

/** Code spend per session (priced per model). `userId` null = everyone in `sessionIds`. */
async function codeSpendBySession(
  client: Client, rates: ModelRates, start: number, end: number,
  filter: SessionFilter,
  unpriced: Set<string>,
  withSplit = false,
): Promise<Map<string, SessionAcc>> {
  const cam = schema.codeAssistantMeta;
  // The subagent/skill split groups finer, so it is asked for only for the
  // person under review, never for the colleague population.
  const recorded = sql<boolean>`(${cam.query_source} IS NOT NULL)`;
  const select = {
    session_id: cam.session_id,
    user_id: cam.user_id,
    model: cam.model,
    i: sql<string>`SUM(${cam.input_tokens})`,
    o: sql<string>`SUM(${cam.output_tokens})`,
    cw: sql<string>`SUM(${cam.cache_creation_tokens})`,
    cr: sql<string>`SUM(${cam.cache_read_tokens})`,
    agent: withSplit ? cam.agent_name : sql<string | null>`NULL`,
    skill: withSplit ? cam.skill_name : sql<string | null>`NULL`,
    recorded: withSplit ? recorded : sql<boolean>`FALSE`,
    calls: sql<string>`COUNT(*)`,
  };
  const groupCols = withSplit
    ? [cam.session_id, cam.user_id, cam.model, cam.agent_name, cam.skill_name, recorded]
    : [cam.session_id, cam.user_id, cam.model];
  const timeWhere = and(gte(cam.occurred_at, start), lt(cam.occurred_at, end));
  const rows = 'all' in filter
    ? await client.select(select).from(cam).where(timeWhere).groupBy(...groupCols)
    : 'userId' in filter
    ? await client.select(select).from(cam).where(and(timeWhere, eq(cam.user_id, filter.userId))).groupBy(...groupCols)
    : await inChunks(filter.sessionIds, part => client.select(select).from(cam).where(and(timeWhere, inArray(cam.session_id, part))).groupBy(...groupCols));

  const out = new Map<string, SessionAcc>();
  for (const r of rows) {
    if (!r.user_id) continue;
    const acc = out.get(r.session_id) ?? newAcc('code', r.session_id, r.user_id);
    out.set(r.session_id, acc);
    if (!r.model) continue;
    const usage: TokenUsage = { inputTokens: Number(r.i) || 0, outputTokens: Number(r.o) || 0, cacheCreationTokens: Number(r.cw) || 0, cacheReadTokens: Number(r.cr) || 0 };
    const usd = priceTokens(r.model, usage, rates);
    if (withSplit) {
      const agent = r.agent || null;
      acc.split.add({ model: r.model, subagent: agent, skill: r.skill || null, sourceRecorded: r.recorded === true || !!agent, usd, calls: Number(r.calls) || 0 });
      if (agent) acc.subagents.add(agent);
    }
    if (usd === null) { acc.hasUnpriced = true; acc.unpricedModels.add(r.model); unpriced.add(r.model); continue; }
    acc.spend += usd;
    acc.priced = true;
    addNum(acc.spendByModel, r.model, usd);
    addUsage(acc.usageByModel, r.model, usage);
  }
  return out;
}

/** Cowork spend per session (the stored, measured cost_usd). */
async function coworkSpendBySession(
  client: Client, start: number, end: number,
  filter: SessionFilter,
): Promise<Map<string, SessionAcc>> {
  const cm = schema.coworkMessages;
  const select = { session_id: cm.session_id, user_id: cm.user_id, model: cm.model, cost_usd: cm.cost_usd, token_usage: cm.token_usage, agent_name: cm.agent_name, skill_name: cm.skill_name, query_source: cm.query_source };
  const where = and(eq(cm.message_type, 'cowork_api_request'), gte(cm.occurred_at, start), lt(cm.occurred_at, end));
  const rows = 'all' in filter
    ? await client.select(select).from(cm).where(where)
    : 'userId' in filter
    ? await client.select(select).from(cm).where(and(where, eq(cm.user_id, filter.userId)))
    : await inChunks(filter.sessionIds, part => client.select(select).from(cm).where(and(where, inArray(cm.session_id, part))));

  const out = new Map<string, SessionAcc>();
  for (const r of rows) {
    if (!r.user_id) continue;
    const acc = out.get(r.session_id) ?? newAcc('cowork', r.session_id, r.user_id);
    out.set(r.session_id, acc);
    const cost = r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd);
    acc.split.add({ model: r.model, subagent: r.agent_name, skill: r.skill_name, sourceRecorded: r.query_source !== null || r.agent_name !== null, usd: cost !== null && Number.isFinite(cost) ? cost : null, calls: 1 });
    if (r.agent_name) acc.subagents.add(r.agent_name);
    if (cost !== null && Number.isFinite(cost)) {
      acc.spend += cost;
      acc.priced = true;
      if (r.model) addNum(acc.spendByModel, r.model, cost);
    }
    const usage = parseCoworkTokenUsage(jsonToText(r.token_usage));
    if (usage && r.model) addUsage(acc.usageByModel, r.model, usage);
  }
  return out;
}

async function codeWorkTypes(client: Client, sessionIds: string[]): Promise<Map<string, { workType: string; tier: number }>> {
  const csc = schema.codeSessionClassifications;
  const rows = await inChunks(sessionIds, part => client
    .select({ session_id: csc.session_id, work_type: csc.work_type, tier: csc.tier })
    .from(csc)
    .where(and(inArray(csc.session_id, part), eq(csc.status, 'classified'))));
  return new Map(rows.map(r => [r.session_id, { workType: r.work_type, tier: Number(r.tier) }]));
}

async function coworkTiers(client: Client, sessionIds: string[]): Promise<Map<string, number>> {
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const rows = await inChunks(sessionIds, part => client
    .select({ session_id: cm.session_id, tier: sql<string>`MAX(${pc.tier})` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(cm.session_id, part), eq(pc.classifier_status, 'classified')))
    .groupBy(cm.session_id));
  return new Map(rows.map(r => [r.session_id, Number(r.tier)]));
}

/** Session id → scheduled-task name, for sessions whose prompt opens `<scheduled-task name="...">`. */
async function scheduledTaskNames(client: Client, sessionIds: string[]): Promise<Map<string, string>> {
  const cm = schema.coworkMessages;
  const out = new Map<string, string>();
  for (const r of await inChunks(sessionIds, part => client
    .select({ session_id: cm.session_id, head: sql<string>`LEFT(${cm.content_full}, 300)` })
    .from(cm)
    .where(and(inArray(cm.session_id, part), inArray(cm.message_type, ['code_user_message', 'cowork_user_message']), sql`${cm.content_full} LIKE '<scheduled-task%'`)))) {
    const name = scheduledTaskName(r.head);
    if (name && r.session_id && !out.has(r.session_id)) out.set(r.session_id, name);
  }
  return out;
}

/** Group a person's month of sessions into scheduled tasks. */
function scheduledTasksFrom(
  accs: SessionAcc[], names: Map<string, string>, startedAt: (id: string) => number | null, rates: ModelRates,
): ScheduledTask[] {
  const groups = new Map<string, { surface: ReviewSurface; sessions: Array<{ startedAt: number | null; spendByModel: Map<string, number> }> }>();
  for (const a of accs) {
    const name = names.get(a.sessionId);
    if (!name) continue;
    const key = `${a.surface}:${name}`;
    const g = groups.get(key) ?? { surface: a.surface, sessions: [] };
    groups.set(key, g);
    g.sessions.push({ startedAt: startedAt(a.sessionId), spendByModel: a.spendByModel });
  }
  return [...groups.entries()]
    .map(([key, g]) => summariseScheduledTask(key.slice(key.indexOf(':') + 1), g.surface, g.sessions, rates))
    .sort((a, b) => b.spendUsd - a.spendUsd);
}

async function sessionTools(client: Client, sessionIds: string[]): Promise<Map<string, { userId: string; skills: Set<string>; connectors: Set<string> }>> {
  const out = new Map<string, { userId: string; skills: Set<string>; connectors: Set<string> }>();
  const get = (sid: string, uid: string) => {
    let e = out.get(sid);
    if (!e) { e = { userId: uid, skills: new Set(), connectors: new Set() }; out.set(sid, e); }
    return e;
  };
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const skills = await inChunks(sessionIds, part => client.selectDistinct({ session_id: csi.session_id, user_id: csi.user_id, name: csi.skill_name }).from(csi).where(inArray(csi.session_id, part)));
  for (const r of skills) get(r.session_id, r.user_id).skills.add(r.name);
  const conns = await inChunks(sessionIds, part => client.selectDistinct({ session_id: cmi.session_id, user_id: cmi.user_id, name: cmi.mcp_server }).from(cmi).where(inArray(cmi.session_id, part)));
  for (const r of conns) get(r.session_id, r.user_id).connectors.add(r.name);
  return out;
}

// ─── The review ──────────────────────────────────────────────────────────────

export async function buildSpendReview(
  userId: string,
  period: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<SpendReview> {
  const client = await getTypedClient();
  const rates = await getCodeModelRates();
  const { start, end } = monthBounds(period);
  const person = await resolvePerson(client, userId);
  const codeDefs = await loadCodeDefs();
  const unpriced = new Set<string>();

  // 1. The person's sessions and spend this month.
  const codeAcc = await codeSpendBySession(client, rates, start, end, { userId }, unpriced, true);
  const coworkAcc = await coworkSpendBySession(client, start, end, { userId });
  const codeIds = [...codeAcc.keys()];
  const coworkIds = [...coworkAcc.keys()];

  const codeWork = await codeWorkTypes(client, codeIds);
  const coworkWork = await buildSessionTaskTypeMap(client, coworkIds);
  const coworkTier = await coworkTiers(client, coworkIds);
  const tools = await sessionTools(client, [...codeIds, ...coworkIds]);

  const css = schema.codeSessionStats;
  const codeStats = new Map((await inChunks(codeIds, part => client
    .select({ session_id: css.session_id, first_at: css.first_at, last_at: css.last_at, active_secs: css.active_secs, prompts: css.user_msg_count, actions: css.tool_use_count, commits: css.commit_count })
    .from(css).where(inArray(css.session_id, part)))).map(r => [r.session_id, r]));

  const cws = schema.coworkSessionStats;
  const coworkStats = new Map((await inChunks(coworkIds, part => client
    .select({ session_id: cws.session_id, first_at: cws.first_event_at, last_at: cws.last_event_at, active_secs: cws.active_secs, actions: cws.tool_call_count, produced: cws.produced_output })
    .from(cws).where(inArray(cws.session_id, part)))).map(r => [r.session_id, r]));

  const cm = schema.coworkMessages;
  const promptCounts = new Map((await inChunks(coworkIds, part => client
    .select({ session_id: cm.session_id, n: sql<string>`COUNT(*)` })
    .from(cm).where(and(inArray(cm.session_id, part), eq(cm.message_type, 'cowork_user_message')))
    .groupBy(cm.session_id))).map(r => [r.session_id, Number(r.n)]));

  const outputs = new Map<string, string[]>();
  for (const r of await inChunks(coworkIds, part => client
    .selectDistinct({ session_id: cm.session_id, name: cm.output_name })
    .from(cm).where(and(inArray(cm.session_id, part), isNotNull(cm.output_name))))) {
    const list = outputs.get(r.session_id) ?? [];
    if (r.name && list.length < MAX_OUTPUTS_PER_SESSION) list.push(r.name);
    outputs.set(r.session_id, list);
  }

  const sessions: ReviewSession[] = [];
  for (const acc of codeAcc.values()) {
    const st = codeStats.get(acc.sessionId);
    const w = codeWork.get(acc.sessionId);
    const t = tools.get(acc.sessionId);
    sessions.push({
      surface: 'code', sessionId: acc.sessionId,
      startedAt: st ? Number(st.first_at) : null,
      endedAt: st ? Number(st.last_at) : null, scheduledTask: null,
      workKey: w?.workType ?? null, workLabel: workLabel('code', w?.workType ?? null, codeDefs), tier: w?.tier ?? null,
      activeSecs: st?.active_secs == null ? null : Number(st.active_secs),
      prompts: st ? Number(st.prompts) : null, actions: st ? Number(st.actions) : null,
      spendUsd: acc.priced ? acc.spend : null, hasUnpriced: acc.hasUnpriced,
      models: [...new Set([...acc.spendByModel.keys(), ...acc.usageByModel.keys()])],
      skills: t ? [...t.skills] : [], connectors: t ? [...t.connectors] : [], subagents: [...acc.subagents].sort(), outputs: [],
      commits: st ? Number(st.commits) : null, producedOutput: null,
    });
  }
  for (const acc of coworkAcc.values()) {
    const st = coworkStats.get(acc.sessionId);
    const key = coworkWork.get(acc.sessionId) ?? null;
    const t = tools.get(acc.sessionId);
    sessions.push({
      surface: 'cowork', sessionId: acc.sessionId,
      startedAt: st?.first_at == null ? null : Number(st.first_at),
      endedAt: st?.last_at == null ? null : Number(st.last_at), scheduledTask: null,
      workKey: key, workLabel: workLabel('cowork', key), tier: coworkTier.get(acc.sessionId) ?? null,
      activeSecs: st?.active_secs == null ? null : Number(st.active_secs),
      prompts: promptCounts.get(acc.sessionId) ?? 0, actions: st ? Number(st.actions) : null,
      spendUsd: acc.priced ? acc.spend : null, hasUnpriced: false,
      models: [...acc.spendByModel.keys()],
      skills: t ? [...t.skills] : [], connectors: t ? [...t.connectors] : [], subagents: [...acc.subagents].sort(), outputs: outputs.get(acc.sessionId) ?? [],
      commits: null, producedOutput: st?.produced == null ? null : Number(st.produced) === 1,
    });
  }

  const taskNames = await scheduledTaskNames(client, [...codeIds, ...coworkIds]);
  for (const s of sessions) s.scheduledTask = taskNames.get(s.sessionId) ?? null;
  const startedById = new Map(sessions.map(s => [s.sessionId, s.startedAt]));
  const scheduledTasks = scheduledTasksFrom([...codeAcc.values(), ...coworkAcc.values()], taskNames, id => startedById.get(id) ?? null, rates);

  const codeUsd = [...codeAcc.values()].reduce((a, s) => a + s.spend, 0);
  const coworkUsd = [...coworkAcc.values()].reduce((a, s) => a + s.spend, 0);
  const totalUsd = codeUsd + coworkUsd;

  // 2. Group by kind of work.
  const groups = new Map<string, { surface: ReviewSurface; workKey: string | null; sessions: ReviewSession[]; accs: SessionAcc[] }>();
  for (const s of sessions) {
    const key = `${s.surface}:${s.workKey ?? 'unclassified'}`;
    const g = groups.get(key) ?? { surface: s.surface, workKey: s.workKey, sessions: [], accs: [] };
    g.sessions.push(s);
    g.accs.push((s.surface === 'code' ? codeAcc : coworkAcc).get(s.sessionId)!);
    groups.set(key, g);
  }

  // 3. Colleagues doing the same kinds of work.
  const peerEnd = Math.min(end, nowS);
  const peerStart = peerEnd - PEER_WINDOW_DAYS * 86400;
  const kindKeys = [...groups.keys()].filter(k => !k.endsWith(':unclassified'));
  const population = await buildPopulation(client, rates, peerStart, peerEnd, kindKeys);
  const personTools = (await toolsUsedByUser(client, peerStart, peerEnd, [userId])).get(userId) ?? emptyTools();
  const library = await libraryEntries(client, population.toolNames);

  const work: WorkRow[] = [];
  for (const [key, g] of groups) {
    const spendUsd = g.accs.reduce((a, s) => a + s.spend, 0);
    const pricedSpends = g.accs.filter(s => s.priced).map(s => s.spend);
    const measured = g.sessions.filter(s => s.producedOutput !== null);
    const personSpendByModel = new Map<string, number>();
    const personUsageByModel = new Map<string, TokenUsage>();
    for (const a of g.accs) {
      for (const [m, v] of a.spendByModel) addNum(personSpendByModel, m, v);
      for (const [m, u] of a.usageByModel) addUsage(personUsageByModel, m, u);
    }
    const top = [...personSpendByModel.entries()].sort((a, b) => b[1] - a[1])[0];
    const personByModel = new Map<string, ModelTally>();
    g.sessions.forEach((sess, i) => {
      const acc = g.accs[i];
      const main = mainModel(acc.spendByModel);
      if (!main) return;
      const t = personByModel.get(main) ?? newTally();
      personByModel.set(main, t);
      tallySession(t, { userId, spend: acc.priced ? acc.spend : null, produced: sess.producedOutput, tier: sess.tier });
    });

    const share = totalUsd > 0 ? spendUsd / totalUsd : 0;
    const pop = g.workKey ? population.byKind.get(key) : undefined;
    const p = pop ? peersExcluding(pop, userId) : undefined;
    const peerOk = !!p && p.users.size >= MIN_PEER_USERS && p.sessionSpends.length >= MIN_PEER_SESSIONS;
    const fit = p && peerOk
      ? routesFor({ share, spendUsd, surface: g.surface, byModel: personByModel, usageByModel: personUsageByModel }, p, personTools, library, person.department, rates)
      // Too few colleagues: still show the person's own models for this work.
      : { routes: [], models: deriveModelFit(g.surface, personByModel, new Map(), personUsageByModel, rates, spendUsd).rows };
    const models = withPersonSpend(fit.models, personSpendByModel, spendUsd, new Set(g.accs.flatMap(a => [...a.unpricedModels])));
    const context = g.workKey && share >= MIN_WORK_SHARE_FOR_ROUTES && p && peerOk ? contextAdvice(personUsageByModel, p.usageByModel, rates) : null;
    if (context) fit.routes.push(context);

    work.push({
      key, surface: g.surface, workKey: g.workKey, label: workLabel(g.surface, g.workKey, codeDefs), definition: workDefinition(g.surface, g.workKey, codeDefs),
      spendUsd, share, sessions: g.sessions.length,
      ...sessionSpan(g.sessions),
      typicalSessionUsd: median(pricedSpends),
      peer: p && p.users.size > 0 ? { users: p.users.size, sessions: p.sessionCount, typicalSessionUsd: peerOk ? median(p.sessionSpends) : null } : null,
      produced: g.surface === 'cowork' && measured.length > 0 ? { measured: measured.length, produced: measured.filter(s => s.producedOutput).length } : null,
      commits: g.surface === 'code' ? g.sessions.reduce((a, s) => a + (s.commits ?? 0), 0) : null,
      deepSessions: g.sessions.filter(s => (s.tier ?? 0) >= 3).length,
      topModel: top && spendUsd > 0 ? { model: top[0], share: top[1] / spendUsd } : null,
      routes: fit.routes,
      models,
      split: mergeSplits(g.accs),
    });
  }
  // Spend first; unclassified always last.
  work.sort((a, b) => (a.workKey === null ? 1 : 0) - (b.workKey === null ? 1 : 0) || b.spendUsd - a.spendUsd);

  sessions.sort((a, b) => (b.spendUsd ?? -1) - (a.spendUsd ?? -1) || (b.startedAt ?? 0) - (a.startedAt ?? 0));

  // 4. Cost drivers across the whole month, priced models only (as FinOps).
  const allSpend = new Map<string, number>();
  const allUsage = new Map<string, TokenUsage>();
  for (const a of [...codeAcc.values(), ...coworkAcc.values()]) {
    for (const [m, v] of a.spendByModel) addNum(allSpend, m, v);
    for (const [m, u] of a.usageByModel) addUsage(allUsage, m, u);
  }
  const modelOrder = rankModelsByPrice([...allSpend.keys()], rates);
  const tokensOf = (u: TokenUsage | undefined) => u ? u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens : 0;
  const spendByModelList: ModelSpend[] = modelOrder
    .map((model, i) => ({ model, tier: i + 1, spendUsd: allSpend.get(model) ?? 0, tokens: tokensOf(allUsage.get(model)) }))
    .sort((a, b) => b.spendUsd - a.spendUsd);
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const m of modelOrder) {
    const u = allUsage.get(m);
    if (!u) continue;
    totalUsage.inputTokens += u.inputTokens;
    totalUsage.outputTokens += u.outputTokens;
    totalUsage.cacheCreationTokens += u.cacheCreationTokens;
    totalUsage.cacheReadTokens += u.cacheReadTokens;
  }

  return {
    userId,
    displayName: person.displayName,
    email: person.email,
    department: person.department,
    period,
    periodStart: start,
    periodEnd: end,
    totals: { totalUsd, codeUsd, coworkUsd, sessions: sessions.length },
    unpricedModels: [...unpriced].sort(),
    work,
    sessions: sessions.slice(0, MAX_SESSIONS_LISTED),
    sessionsTotal: sessions.length,
    scheduledTasks,
    peerWindowDays: PEER_WINDOW_DAYS,
    modelEfficiency: {
      modelOrder,
      spendByModel: spendByModelList,
      costByType: computeCostByType(spendByModelList, allUsage, rates),
      cacheEfficiency: computeCacheEfficiency(totalUsage),
    },
  };
}

/** One key per distinct suggestion, whichever kind of work it appears under. */
/** A scheduled run's prompt opens `<scheduled-task name="...">`; anything else is not one. */
export function scheduledTaskName(prompt: string | null | undefined): string | null {
  const m = /^\s*<scheduled-task\s+name="([^"]+)"/.exec(prompt ?? '');
  return m ? m[1] : null;
}

/** A scheduled task needs at least this many runs in the month, and this much spend, to get a suggestion. */
export const SCHEDULED_MIN_RUNS = 2;
export const SCHEDULED_MIN_USD = MIN_SAVE_FLOOR_USD;
/** At least this share of the task's spend must be on costly models before it is suggested. */
export const SCHEDULED_COSTLY_SHARE = 0.5;

/**
 * For a costly model (one a Sonnet model undercuts to at most SAVE_MAX_COST_RATIO of its price per
 * token, i.e. Opus and Fable class), the cheaper families worth trying: Sonnet, and Haiku when it also
 * clears the bar. Empty for an unpriced model, or a Sonnet/Haiku one (the suggestion
 * is about routine scheduled work running on Opus).
 */
export function cheaperFamiliesFor(model: string, rates: ModelRates): string[] {
  const r = rates[model] ?? rates[normalizeModelId(model)];
  if (!r) return [];
  const price = modelPrice(r);
  const undercuts = (needle: string) => Object.entries(rates).some(([m, rate]) =>
    m.startsWith('claude-') && m.includes(needle) && modelPrice(rate) > 0 && modelPrice(rate) <= price * SAVE_MAX_COST_RATIO);
  if (!undercuts('sonnet')) return [];
  return undercuts('haiku') ? ['Sonnet', 'Haiku'] : ['Sonnet'];
}

/** Pure: one scheduled task's figures and whether to suggest a cheaper model for it. */
export function summariseScheduledTask(
  name: string, surface: ReviewSurface, sessions: Array<{ startedAt: number | null; spendByModel: Map<string, number> }>, rates: ModelRates,
): ScheduledTask {
  const byModel = new Map<string, number>();
  const days = new Set<string>();
  for (const s of sessions) {
    for (const [m, v] of s.spendByModel) byModel.set(m, (byModel.get(m) ?? 0) + v);
    if (s.startedAt) days.add(new Date(s.startedAt * 1000).toISOString().slice(0, 10));
  }
  const spendUsd = [...byModel.values()].reduce((a, v) => a + v, 0);
  const ranked = [...byModel.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const costly = ranked.filter(([m]) => cheaperFamiliesFor(m, rates).length > 0);
  const costlyUsd = costly.reduce((a, [, v]) => a + v, 0);
  const costlyShare = spendUsd > 0 ? costlyUsd / spendUsd : 0;
  const costlyModel = costly[0]?.[0] ?? null;
  const suggest = !!costlyModel && sessions.length >= SCHEDULED_MIN_RUNS && spendUsd >= SCHEDULED_MIN_USD && costlyShare >= SCHEDULED_COSTLY_SHARE;
  return {
    name, surface, runs: sessions.length, days: days.size, spendUsd,
    mainModel: ranked[0]?.[0] ?? null, costlyShare, costlyModel,
    cheaperFamilies: suggest ? cheaperFamiliesFor(costlyModel!, rates) : [],
  };
}

/** The work-level span and active time, from the sessions in it. */
function sessionSpan(sessions: ReviewSession[]): { activeSecs: number | null; firstAt: number | null; lastAt: number | null } {
  const measured = sessions.filter(s => s.activeSecs !== null);
  const starts = sessions.map(s => s.startedAt).filter((v): v is number => v !== null);
  const ends = sessions.map(s => s.endedAt ?? s.startedAt).filter((v): v is number => v !== null);
  return {
    activeSecs: measured.length ? measured.reduce((a, s) => a + (s.activeSecs ?? 0), 0) : null,
    firstAt: starts.length ? Math.min(...starts) : null,
    lastAt: ends.length ? Math.max(...ends) : null,
  };
}

export function suggestionKey(r: ReviewRoute): string {
  if (r.kind === 'tool') return `tool:${r.toolType}:${r.name}`;
  if (r.kind === 'context') return 'context';
  return `model:${r.direction}:${r.toModel}`;
}

function toolKey(type: 'skill' | 'connector', name: string): string {
  return `${type}\u0000${name}`;
}
function splitToolKey(key: string): ['skill' | 'connector', string] {
  const i = key.indexOf('\u0000');
  return [key.slice(0, i) as 'skill' | 'connector', key.slice(i + 1)];
}

interface PeerKind {
  users: Set<string>;
  sessionCount: number;
  sessionSpends: number[];
  spendByModel: Map<string, number>;
  toolUsers: Map<string, Set<string>>;
  toolSessions: Map<string, number>;
  byModel: Map<string, ModelTally>;
  usageByModel: Map<string, TokenUsage>;
}

/** One person's sessions of a kind of work over the peer window. */
interface UserKindShare {
  sessions: number;
  sessionSpends: number[];
  spendByModel: Map<string, number>;
  toolSessions: Map<string, number>;
  /** Sessions by the model that carried most of their spend. */
  byModel: Map<string, ModelTally>;
  usageByModel: Map<string, TokenUsage>;
}

/** Everyone's sessions of each kind of work, kept per person so any one person can be left out. */
interface Population {
  byKind: Map<string, Map<string, UserKindShare>>;
  toolNames: string[];
}

/**
 * Everyone's sessions of the given kinds of work (keys `${surface}:${workKey}`)
 * in the window. Built once; `peersExcluding` then gives any person's
 * colleagues, so the index and each review work routes out the same way.
 */
async function buildPopulation(client: Client, rates: ModelRates, start: number, end: number, kindKeys: string[]): Promise<Population> {
  const codeKinds = kindKeys.filter(k => k.startsWith('code:')).map(k => k.slice('code:'.length));
  const coworkKinds = kindKeys.filter(k => k.startsWith('cowork:')).map(k => k.slice('cowork:'.length));
  const sessionKind = new Map<string, string>(); // sessionId → `${surface}:${kind}`
  const sessionTier = new Map<string, number>();

  if (codeKinds.length) {
    const csc = schema.codeSessionClassifications;
    const css = schema.codeSessionStats;
    const rows = await client
      .select({ session_id: csc.session_id, work_type: csc.work_type, tier: csc.tier })
      .from(csc)
      .innerJoin(css, eq(css.session_id, csc.session_id))
      .where(and(inArray(csc.work_type, codeKinds), eq(csc.status, 'classified'), gte(css.last_at, start), lt(css.first_at, end)));
    for (const r of rows) { sessionKind.set(r.session_id, `code:${r.work_type}`); sessionTier.set(r.session_id, Number(r.tier)); }
  }

  if (coworkKinds.length) {
    // Candidate sessions carrying any of the labels, then the same per-session
    // collapse every person's own sessions go through.
    const pc = schema.pulseClassifications;
    const cm = schema.coworkMessages;
    const cand = await client
      .selectDistinct({ session_id: cm.session_id })
      .from(pc)
      .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
      .where(and(inArray(pc.task_type, coworkKinds), gte(cm.occurred_at, start), lt(cm.occurred_at, end)));
    const wanted = new Set(coworkKinds);
    for (const part of chunks(cand.map(r => r.session_id))) {
      for (const [sid, kind] of await buildSessionTaskTypeMap(client, part)) if (wanted.has(kind)) sessionKind.set(sid, `cowork:${kind}`);
    }
  }

  const codeIds = [...sessionKind.entries()].filter(([, k]) => k.startsWith('code:')).map(([sid]) => sid);
  const coworkIds = [...sessionKind.entries()].filter(([, k]) => k.startsWith('cowork:')).map(([sid]) => sid);
  const accs = [
    ...(await codeSpendBySession(client, rates, start, end, { sessionIds: codeIds }, new Set())).values(),
    ...(await coworkSpendBySession(client, start, end, { sessionIds: coworkIds })).values(),
  ];
  const tools = await sessionTools(client, [...codeIds, ...coworkIds]);
  for (const [sid, tier] of await coworkTiers(client, coworkIds)) sessionTier.set(sid, tier);
  const cws = schema.coworkSessionStats;
  const produced = new Map((await inChunks(coworkIds, part => client
    .select({ session_id: cws.session_id, produced: cws.produced_output })
    .from(cws).where(inArray(cws.session_id, part)))).map(r => [r.session_id, r.produced == null ? null : Number(r.produced) === 1]));

  const byKind = new Map<string, Map<string, UserKindShare>>();
  const toolNames = new Set<string>();
  for (const acc of accs) {
    const kind = sessionKind.get(acc.sessionId);
    if (!kind) continue;
    const users = byKind.get(kind) ?? new Map<string, UserKindShare>();
    byKind.set(kind, users);
    const u: UserKindShare = users.get(acc.userId) ?? { sessions: 0, sessionSpends: [], spendByModel: new Map(), toolSessions: new Map(), byModel: new Map(), usageByModel: new Map() };
    users.set(acc.userId, u);
    u.sessions += 1;
    if (acc.priced) u.sessionSpends.push(acc.spend);
    for (const [m, v] of acc.spendByModel) addNum(u.spendByModel, m, v);
    for (const [m, us] of acc.usageByModel) addUsage(u.usageByModel, m, us);
    const main = mainModel(acc.spendByModel);
    if (main) {
      const t = u.byModel.get(main) ?? newTally();
      u.byModel.set(main, t);
      tallySession(t, { userId: acc.userId, spend: acc.priced ? acc.spend : null, produced: produced.get(acc.sessionId) ?? null, tier: sessionTier.get(acc.sessionId) ?? null });
    }
    const t = tools.get(acc.sessionId);
    if (!t) continue;
    for (const [type, names] of [['skill', t.skills], ['connector', t.connectors]] as const) {
      for (const name of names) {
        addNum(u.toolSessions, toolKey(type, name), 1);
        toolNames.add(name);
      }
    }
  }
  return { byKind, toolNames: [...toolNames] };
}

/** Everyone who did a kind of work, except one person. */
function peersExcluding(pop: Map<string, UserKindShare>, userId: string): PeerKind {
  const pk: PeerKind = { users: new Set(), sessionCount: 0, sessionSpends: [], spendByModel: new Map(), toolUsers: new Map(), toolSessions: new Map(), byModel: new Map(), usageByModel: new Map() };
  for (const [uid, u] of pop) {
    if (uid === userId) continue;
    for (const [m, us] of u.usageByModel) addUsage(pk.usageByModel, m, us);
    for (const [m, t] of u.byModel) {
      const into = pk.byModel.get(m) ?? newTally();
      pk.byModel.set(m, into);
      mergeTally(into, t);
    }
    pk.users.add(uid);
    pk.sessionCount += u.sessions;
    pk.sessionSpends.push(...u.sessionSpends);
    for (const [m, v] of u.spendByModel) addNum(pk.spendByModel, m, v);
    for (const [k, n] of u.toolSessions) {
      addNum(pk.toolSessions, k, n);
      const set = pk.toolUsers.get(k) ?? new Set<string>();
      set.add(uid);
      pk.toolUsers.set(k, set);
    }
  }
  return pk;
}

type Tools = { skills: Set<string>; connectors: Set<string> };
function emptyTools(): Tools {
  return { skills: new Set(), connectors: new Set() };
}

/**
 * The better routes for one person's kind of work, given colleagues who did
 * enough of it. Nothing on work below MIN_WORK_SHARE_FOR_ROUTES of the
 * person's spend: it cannot change where the money goes. A skill or connector
 * must be used by MIN_PEER_USERS colleagues in at least MIN_TOOL_SESSION_SHARE
 * of their sessions of that work: a habit, not an occasional reach.
 */
function routesFor(
  person: { share: number; spendUsd: number; surface: ReviewSurface; byModel: Map<string, ModelTally>; usageByModel: Map<string, TokenUsage> },
  p: PeerKind,
  personTools: Tools,
  library: Map<string, { id: number; department: string | null }>,
  department: string | null,
  rates: ModelRates,
): { routes: ReviewRoute[]; models: ModelFitRow[] } {
  const fit = deriveModelFit(person.surface, person.byModel, p.byModel, person.usageByModel, rates, person.spendUsd);
  if (person.share < MIN_WORK_SHARE_FOR_ROUTES) return { routes: [], models: fit.rows };
  const toolRoutes: Extract<ReviewRoute, { kind: 'tool' }>[] = [];
  for (const [key, users] of p.toolUsers) {
    if (users.size < MIN_PEER_USERS) continue;
    const peerSessionShare = (p.toolSessions.get(key) ?? 0) / p.sessionCount;
    if (peerSessionShare < MIN_TOOL_SESSION_SHARE) continue;
    const [toolType, name] = splitToolKey(key);
    if (isBuiltInTool(toolType, name)) continue; // ships with Claude: nothing to adopt
    if ((toolType === 'skill' ? personTools.skills : personTools.connectors).has(name)) continue;
    const lib = library.get(name);
    // On the Board but restricted to another department: the person could not see it there.
    if (lib?.department && lib.department !== department) continue;
    toolRoutes.push({ kind: 'tool', toolType, name, peerUsers: users.size, peerSessionShare, libraryEntryId: lib?.id ?? null });
  }
  toolRoutes.sort((a, b) => b.peerUsers - a.peerUsers || b.peerSessionShare - a.peerSessionShare);
  const routes: ReviewRoute[] = toolRoutes.slice(0, MAX_TOOL_ROUTES);
  if (fit.advice) routes.push(fit.advice);
  if (fit.trial) routes.push(fit.trial);
  return { routes, models: fit.rows };
}

/** Every skill and connector each person used in the window, any kind of work. Null = everyone. */
async function toolsUsedByUser(client: Client, start: number, end: number, userIds: string[] | null): Promise<Map<string, Tools>> {
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const out = new Map<string, Tools>();
  const get = (uid: string) => { let t = out.get(uid); if (!t) { t = emptyTools(); out.set(uid, t); } return t; };
  const skillWhere = and(gte(csi.occurred_at, start), lt(csi.occurred_at, end), userIds ? inArray(csi.user_id, userIds) : undefined);
  const connWhere = and(gte(cmi.occurred_at, start), lt(cmi.occurred_at, end), userIds ? inArray(cmi.user_id, userIds) : undefined);
  for (const r of await client.selectDistinct({ user_id: csi.user_id, name: csi.skill_name }).from(csi).where(skillWhere)) get(r.user_id).skills.add(r.name);
  for (const r of await client.selectDistinct({ user_id: cmi.user_id, name: cmi.mcp_server }).from(cmi).where(connWhere)) get(r.user_id).connectors.add(r.name);
  return out;
}

/** Board entries by name, with the department an entry is restricted to (null = everyone). Absent = not on the Board. */
async function libraryEntries(client: Client, names: string[]): Promise<Map<string, { id: number; department: string | null }>> {
  const out = new Map<string, { id: number; department: string | null }>();
  if (!names.length) return out;
  const sle = schema.skillLibraryEntries;
  const rows = await inChunks(names, part => client
    .select({ id: sle.id, name: sle.name, department: sle.department })
    .from(sle).where(inArray(sle.name, part)));
  // Claimed or not, an entry has a Board page to link to.
  for (const r of rows) out.set(r.name, { id: Number(r.id), department: r.department ?? null });
  return out;
}

// ─── Index: everyone's month in one pass ─────────────────────────────────────

export interface SpendReviewPerson {
  userId: string;
  displayName: string;
  email: string | null;
  department: string | null;
  codeUsd: number;
  coworkUsd: number;
  totalUsd: number;
  /** Last month's measured spend; null when there was none. */
  priorTotalUsd: number | null;
  /** Used Claude this month, but only on models with no price. */
  unpricedOnly: boolean;
  /** The kind of work carrying most of their spend. */
  mainWork: { label: string; surface: ReviewSurface; share: number } | null;
  /** Distinct better routes across their kinds of work (a tool suggested for two kinds counts once). */
  routeCount: number;
  /** Working figures for the efficiency board; removed before the index is returned. */
  _efficiency?: { vsColleagues: number | null; sessions: number; deepRate: number | null; peerDeepRate: number | null } | null;
}

/** One row of "Most efficient this month". */
export interface EfficiencyEntry {
  userId: string;
  displayName: string;
  department: string | null;
  /** Spend-weighted ratio of the person's typical session cost to colleagues' for the same kinds of work (0.62 = 38% below). */
  vsColleagues: number;
  /** Comparable sessions behind it. */
  sessions: number;
  /** Share of those sessions at Tier 3, beside colleagues' for the same kinds of work. Null when not measured. */
  deepRate: number | null;
  peerDeepRate: number | null;
}

/** People need this many sessions in kinds of work with colleagues to compare against. */
export const EFFICIENCY_MIN_SESSIONS = 10;
/**
 * Only people whose work stayed as deep as colleagues' rank: a Tier 3 share no
 * more than this far below theirs. In Sept 2026 four of the five
 * cheapest had 0% Tier 3 against colleagues' 20-25%: cheaper because shallower.
 */
export const EFFICIENCY_MAX_DEPTH_GAP = 0.1;

export function keepsDepth(deepRate: number | null, peerDeepRate: number | null): boolean {
  if (deepRate === null || peerDeepRate === null) return false;
  return deepRate >= peerDeepRate - EFFICIENCY_MAX_DEPTH_GAP;
}
export const EFFICIENCY_TOP = 10;

/**
 * Spend-weighted ratio of a person's typical session cost to colleagues' for
 * the same kinds of work. Comparing like with like: a person doing bigger
 * kinds of work is compared with colleagues doing those kinds, not with
 * everyone. Null with nothing comparable.
 */
export function efficiencyRatio(kinds: Array<{ spend: number; personMedian: number | null; peerMedian: number | null }>): number | null {
  let weight = 0;
  let sum = 0;
  for (const k of kinds) {
    if (k.personMedian === null || k.peerMedian === null || k.peerMedian <= 0 || k.spend <= 0) continue;
    weight += k.spend;
    sum += k.spend * (k.personMedian / k.peerMedian);
  }
  return weight > 0 ? sum / weight : null;
}

export interface SpendReviewIndex {
  period: string;
  people: SpendReviewPerson[];
  /** Most efficient this month: lowest cost against colleagues for the same work, with results beside it. */
  efficiency: EfficiencyEntry[];
  unpricedModels: string[];
  summary: {
    totalUsd: number;
    priorTotalUsd: number | null;
    people: number;
    /** Fewest people whose spend makes up half the total; null below four people. */
    halfSpendPeople: number | null;
    topWork: { label: string; surface: ReviewSurface; share: number }[];
    peopleWithRoutes: number;
    /** Share of the month's list-price cost that is Claude re-reading earlier conversation, across everyone. */
    orgRereadShare: number | null;
  };
}

export function priorPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Fewest people whose spend makes up half of the total. */
export function halfSpendCount(spends: number[]): number | null {
  const sorted = spends.filter(v => v > 0).sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (sorted.length < 4 || total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i];
    if (acc >= total / 2) return i + 1;
  }
  return sorted.length;
}

interface PersonKind {
  surface: ReviewSurface;
  workKey: string | null;
  spend: number;
  usageByModel: Map<string, TokenUsage>;
  byModel: Map<string, ModelTally>;
}

/**
 * Everyone with Code or Cowork activity in the month, highest spend first.
 * Totals are FinOps's own chargeback figures. Main kind of work and the route
 * count use the same session grouping and the same `routesFor` as a person's
 * review, worked out for everyone in one pass rather than one review each.
 */
export async function buildSpendReviewIndex(period: string, nowS: number = Math.floor(Date.now() / 1000)): Promise<SpendReviewIndex> {
  const client = await getTypedClient();
  const codeDefs = await loadCodeDefs();
  const rates = await getCodeModelRates();
  const { start, end } = monthBounds(period);

  const report = await buildChargeback(period, nowS);
  let prior: Awaited<ReturnType<typeof buildChargeback>> | null = null;
  try { prior = await buildChargeback(priorPeriod(period), nowS); } catch { prior = null; }
  const priorByUser = new Map<string, number>();
  for (const u of prior ? [...prior.costCentres.flatMap(c => c.users), ...prior.unallocated.users] : []) priorByUser.set(u.userId, u.totalUsd);

  const tokenSum = (t: { input: number; output: number; cacheWrite: number; cacheRead: number }) => t.input + t.output + t.cacheWrite + t.cacheRead;
  const users = [...report.costCentres.flatMap(c => c.users), ...report.unallocated.users]
    .filter(u => u.userId !== '__null_user__' && (u.totalUsd > 0 || tokenSum(u.tokens) > 0));

  // Every session this month, grouped per person by kind of work.
  const codeAcc = await codeSpendBySession(client, rates, start, end, { all: true }, new Set());
  const coworkAcc = await coworkSpendBySession(client, start, end, { all: true });
  const codeWork = await codeWorkTypes(client, [...codeAcc.keys()]);
  const coworkIds = [...coworkAcc.keys()];
  const coworkWork = new Map<string, string>();
  for (const part of chunks(coworkIds)) for (const [k, v] of await buildSessionTaskTypeMap(client, part)) coworkWork.set(k, v);
  const coworkTier = await coworkTiers(client, coworkIds);
  const cws = schema.coworkSessionStats;
  const produced = new Map((await inChunks(coworkIds, part => client
    .select({ session_id: cws.session_id, produced: cws.produced_output })
    .from(cws).where(inArray(cws.session_id, part)))).map(r => [r.session_id, r.produced == null ? null : Number(r.produced) === 1]));

  const kindsByUser = new Map<string, Map<string, PersonKind>>();
  const orgUsage = new Map<string, TokenUsage>();
  const orgKindSpend = new Map<string, number>();
  let orgSessionSpend = 0;
  const addSession = (acc: SessionAcc, workKey: string | null, tier: number | null, prod: boolean | null) => {
    const key = `${acc.surface}:${workKey ?? 'unclassified'}`;
    const kinds = kindsByUser.get(acc.userId) ?? new Map<string, PersonKind>();
    kindsByUser.set(acc.userId, kinds);
    const k: PersonKind = kinds.get(key) ?? { surface: acc.surface, workKey, spend: 0, usageByModel: new Map(), byModel: new Map() };
    kinds.set(key, k);
    k.spend += acc.spend;
    for (const [m, u] of acc.usageByModel) { addUsage(k.usageByModel, m, u); addUsage(orgUsage, m, u); }
    const main = mainModel(acc.spendByModel);
    if (main) {
      const t = k.byModel.get(main) ?? newTally();
      k.byModel.set(main, t);
      tallySession(t, { userId: acc.userId, spend: acc.priced ? acc.spend : null, produced: prod, tier });
    }
    if (workKey) addNum(orgKindSpend, key, acc.spend);
    orgSessionSpend += acc.spend;
  };
  for (const acc of codeAcc.values()) { const w = codeWork.get(acc.sessionId); addSession(acc, w?.workType ?? null, w?.tier ?? null, null); }
  for (const acc of coworkAcc.values()) addSession(acc, coworkWork.get(acc.sessionId) ?? null, coworkTier.get(acc.sessionId) ?? null, produced.get(acc.sessionId) ?? null);

  // Colleagues, once for everyone.
  const peerEnd = Math.min(end, nowS);
  const peerStart = peerEnd - PEER_WINDOW_DAYS * 86400;
  const kindKeys = [...orgKindSpend.keys()];
  const population = await buildPopulation(client, rates, peerStart, peerEnd, kindKeys);
  const toolsByUser = await toolsUsedByUser(client, peerStart, peerEnd, null);
  const library = await libraryEntries(client, population.toolNames);
  const peopleInfo = await peopleById(client, users.map(u => u.userId));
  const allTaskNames = await scheduledTaskNames(client, [...codeAcc.keys(), ...coworkAcc.keys()]);
  const accsByUser = new Map<string, SessionAcc[]>();
  for (const a of [...codeAcc.values(), ...coworkAcc.values()]) {
    if (!allTaskNames.has(a.sessionId)) continue;
    const list = accsByUser.get(a.userId) ?? [];
    list.push(a);
    accsByUser.set(a.userId, list);
  }

  const people: SpendReviewPerson[] = users.map(u => {
    const info = peopleInfo.get(u.userId);
    const department = info?.department ?? null;
    const kinds = kindsByUser.get(u.userId) ?? new Map<string, PersonKind>();
    const personTotal = [...kinds.values()].reduce((a, k) => a + k.spend, 0);
    let mainWork: SpendReviewPerson['mainWork'] = null;
    // Distinct suggestions: Slack suggested for three kinds of work is one suggestion.
    const suggestions = new Set<string>();
    const comparable: Array<{ spend: number; personMedian: number | null; peerMedian: number | null }> = [];
    let compSessions = 0, compTiered = 0, compDeep = 0, peerTiered = 0, peerDeep = 0;
    for (const [key, k] of kinds) {
      if (!k.workKey) continue;
      const share = personTotal > 0 ? k.spend / personTotal : 0;
      if (k.spend > 0 && (!mainWork || share > mainWork.share)) mainWork = { label: workLabel(k.surface, k.workKey, codeDefs), surface: k.surface, share };
      const pop = population.byKind.get(key);
      if (!pop) continue;
      const p = peersExcluding(pop, u.userId);
      if (p.users.size < MIN_PEER_USERS || p.sessionSpends.length < MIN_PEER_SESSIONS) continue;
      const mine = [...k.byModel.values()];
      const mySpends = mine.flatMap(t => t.spends);
      if (mySpends.length) {
        comparable.push({ spend: k.spend, personMedian: median(mySpends), peerMedian: median(p.sessionSpends) });
        compSessions += mine.reduce((a, t) => a + t.sessions, 0);
        compTiered += mine.reduce((a, t) => a + t.tiered, 0);
        compDeep += mine.reduce((a, t) => a + t.deep, 0);
        for (const t of p.byModel.values()) { peerTiered += t.tiered; peerDeep += t.deep; }
      }
      if (share >= MIN_WORK_SHARE_FOR_ROUTES && contextAdvice(k.usageByModel, p.usageByModel, rates)) suggestions.add('context');
      for (const r of routesFor({ share, spendUsd: k.spend, surface: k.surface, byModel: k.byModel, usageByModel: k.usageByModel }, p, toolsByUser.get(u.userId) ?? emptyTools(), library, department, rates).routes) suggestions.add(suggestionKey(r));
    }
    // Scheduled tasks on a costly model count as suggestions too, as the person's page shows them.
    for (const t of scheduledTasksFrom(accsByUser.get(u.userId) ?? [], allTaskNames, () => null, rates)) {
      if (t.cheaperFamilies.length) suggestions.add(`scheduled:${t.surface}:${t.name}`);
    }
    return {
      userId: u.userId,
      displayName: info?.displayName ?? u.displayName,
      email: info?.email ?? null,
      department,
      codeUsd: u.codeUsd,
      coworkUsd: u.coworkUsd,
      totalUsd: u.totalUsd,
      priorTotalUsd: priorByUser.get(u.userId) ?? null,
      unpricedOnly: u.totalUsd === 0,
      mainWork,
      routeCount: suggestions.size,
      _efficiency: compSessions >= EFFICIENCY_MIN_SESSIONS ? {
        vsColleagues: efficiencyRatio(comparable),
        sessions: compSessions,
        deepRate: compTiered >= MIN_OUTCOME_SESSIONS ? compDeep / compTiered : null,
        peerDeepRate: peerTiered >= MIN_OUTCOME_SESSIONS ? peerDeep / peerTiered : null,
      } : null,
    };
  });
  people.sort((a, b) => b.totalUsd - a.totalUsd);
  const efficiency: EfficiencyEntry[] = people
    .filter(p => p._efficiency?.vsColleagues != null && p._efficiency.vsColleagues < 1 && keepsDepth(p._efficiency.deepRate, p._efficiency.peerDeepRate))
    .map(p => ({ userId: p.userId, displayName: p.displayName, department: p.department, vsColleagues: p._efficiency!.vsColleagues!, sessions: p._efficiency!.sessions, deepRate: p._efficiency!.deepRate, peerDeepRate: p._efficiency!.peerDeepRate }))
    .sort((a, b) => a.vsColleagues - b.vsColleagues)
    .slice(0, EFFICIENCY_TOP);
  for (const p of people) delete p._efficiency;

  const topWork = [...orgKindSpend.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, v]) => {
      const [surface, ...rest] = key.split(':');
      return { label: workLabel(surface as ReviewSurface, rest.join(':'), codeDefs), surface: surface as ReviewSurface, share: orgSessionSpend > 0 ? v / orgSessionSpend : 0 };
    });

  return {
    period,
    people,
    efficiency,
    unpricedModels: report.unpricedModels,
    summary: {
      totalUsd: report.grandTotalUsd,
      priorTotalUsd: prior && prior.grandTotalUsd > 0 ? prior.grandTotalUsd : null,
      people: people.length,
      halfSpendPeople: halfSpendCount(people.map(p => p.totalUsd)),
      topWork,
      peopleWithRoutes: people.filter(p => p.routeCount > 0).length,
      orgRereadShare: rereadShare(orgUsage, rates),
    },
  };
}

/** Name, email and department for many users (admin_users wins, as elsewhere). */
export async function peopleById(client: Client, ids: string[]): Promise<Map<string, { displayName: string; email: string | null; department: string | null }>> {
  const out = new Map<string, { displayName: string; email: string | null; department: string | null }>();
  if (!ids.length) return out;
  const u = schema.users;
  const au = schema.adminUsers;
  const userRows = await inChunks(ids, part => client.select({ id: u.id, email: u.email, display_name: u.display_name, department: u.department }).from(u).where(inArray(u.id, part)));
  const adminRows = await inChunks(ids, part => client.select({ linked: au.linked_cowork_user_id, display_name: au.display_name, department: au.department }).from(au).where(inArray(au.linked_cowork_user_id, part)));
  const admin = new Map(adminRows.filter(r => r.linked).map(r => [r.linked!, r]));
  for (const r of userRows) {
    const a = admin.get(r.id);
    out.set(r.id, { displayName: filled(a?.display_name) ?? filled(r.display_name) ?? r.email ?? r.id, email: r.email ?? null, department: filled(a?.department) ?? filled(r.department) });
  }
  return out;
}

/** CCC user ids by lower-cased email, for joining Anthropic's members. */
export async function userIdsByEmail(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(emails.map(e => e.toLowerCase()))];
  if (!wanted.length) return out;
  const client = await getTypedClient();
  const u = schema.users;
  const rows = await inChunks(wanted, part => client.select({ id: u.id, email: u.email }).from(u).where(inArray(sql`lower(${u.email})`, part)));
  for (const r of rows) if (r.email && !out.has(r.email.toLowerCase())) out.set(r.email.toLowerCase(), r.id);
  return out;
}

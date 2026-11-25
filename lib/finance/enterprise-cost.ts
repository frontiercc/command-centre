// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic's own cost figures for a month, from the Usage and Cost Analytics
 * API (GET /v1/organizations/analytics/cost, beta header
 * `analytics-usage-cost-2026-08-24`; docs:
 * https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api),
 * mapped into the `EnterpriseCost` shape the FinOps drift check compares
 * against Command Centre's own spend.
 *
 * Key: the Analytics API key (a claude.ai key with `read:analytics`, which a
 * Claude Enterprise organisation needs), else the Admin API key (a Claude
 * Console organisation). Checked live against a Claude Enterprise
 * organisation on 2026-11-25:
 *
 *   - Each row carries a `group` (the dimensions asked for) and a `cost`.
 *     `cost.amount` is a decimal string in CENTS ("2470.59" is $24.71).
 *   - `group.product` names the product: chat, claude_code and cowork map to
 *     Command Centre's three surfaces. Every other product (the Messages API,
 *     Claude Design, Office agents, Smart Reports, the unified Chat and Cowork
 *     experience...) is counted in `otherUsd` and the breakdowns, never in a
 *     surface, so the drift check compares like with like.
 *   - There are no token counts on this endpoint, only cost.
 *   - Without `time_bucket_width` the range comes back as one total per group.
 *     The range may span at most 31 days, which a calendar month never exceeds.
 *
 * Anthropic refreshes these figures within 4 to 24 hours and revises them for
 * about 7 days after a month ends.
 */
import { getConfigValue } from '@/lib/config';
import { withBackoff } from '@/lib/ingestion/scheduler';

const COST_URL = 'https://api.anthropic.com/v1/organizations/analytics/cost';
const COST_BETA = 'analytics-usage-cost-2026-08-24';
/** Pages of up to 1,000 rows; a month of grouped totals is a few hundred. */
const MAX_PAGES = 20;
const GROUP_BY = ['product', 'model', 'context_window', 'speed', 'cost_type', 'token_type'];

/** One row of the cost endpoint, as returned live (the fields read here). */
export interface RawCostRow {
  group?: {
    product?: string | null;
    model?: string | null;
    context_window?: string | null;
    speed?: string | null;
    cost_type?: string | null;
    token_type?: string | null;
  };
  cost?: { amount?: string | null; currency?: string | null };
}

interface RawCostPage {
  data?: RawCostRow[];
  has_more?: boolean;
  next_page?: string | null;
}

export interface EnterpriseCost {
  bySurface: {
    chat: { usd: number };
    code: { usd: number };
    cowork: { usd: number };
  };
  /** Products with no Command Centre surface (Messages API, Claude Design, Office agents...). */
  otherUsd: number;
  byModel: Array<{ model: string; usd: number }>;
  byType: { tokens: number; webSearch: number; codeExecution: number; sessionUsage: number };
  /** 0-200k vs 200k-1M context window, in USD. */
  contextWindow: { standardUsd: number; longUsd: number };
  /** Token cost by token type, in USD (the endpoint has costs, not counts). */
  tokenTypeUsd: { uncachedInput: number; cachedInput: number; cacheCreation: number; output: number };
  fastModeUsd: number;
  standardModeUsd: number;
}

const SURFACE_FOR_PRODUCT: Record<string, 'chat' | 'code' | 'cowork'> = {
  chat: 'chat',
  claude_code: 'code',
  cowork: 'cowork',
};

/** Cents as a decimal string → dollars. Anything unreadable is 0. */
function centsToUsd(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 100 : 0;
}

/** Maps the cost endpoint's rows into `EnterpriseCost`. Never throws on unknown values. */
export function mapCostRows(rows: RawCostRow[]): EnterpriseCost {
  const bySurface = { chat: { usd: 0 }, code: { usd: 0 }, cowork: { usd: 0 } };
  let otherUsd = 0;
  const modelUsd = new Map<string, number>();
  const byType = { tokens: 0, webSearch: 0, codeExecution: 0, sessionUsage: 0 };
  const contextWindow = { standardUsd: 0, longUsd: 0 };
  const tokenTypeUsd = { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 };
  let fastModeUsd = 0;
  let standardModeUsd = 0;

  for (const row of rows) {
    const usd = centsToUsd(row.cost?.amount);
    const g = row.group ?? {};

    const surface = g.product ? SURFACE_FOR_PRODUCT[g.product] : undefined;
    if (surface) bySurface[surface].usd += usd;
    else otherUsd += usd;

    if (g.model) modelUsd.set(g.model, (modelUsd.get(g.model) ?? 0) + usd);

    if (g.cost_type === 'tokens') byType.tokens += usd;
    else if (g.cost_type === 'web_search') byType.webSearch += usd;
    else if (g.cost_type === 'code_execution') byType.codeExecution += usd;
    else if (g.cost_type === 'session_usage') byType.sessionUsage += usd;

    if (g.context_window === '0-200k') contextWindow.standardUsd += usd;
    else if (g.context_window === '200k-1M') contextWindow.longUsd += usd;

    if (g.token_type === 'uncached_input_tokens') tokenTypeUsd.uncachedInput += usd;
    else if (g.token_type === 'cache_read_input_tokens') tokenTypeUsd.cachedInput += usd;
    else if (g.token_type?.startsWith('cache_creation')) tokenTypeUsd.cacheCreation += usd;
    else if (g.token_type === 'output_tokens') tokenTypeUsd.output += usd;

    if (g.speed === 'fast') fastModeUsd += usd;
    else standardModeUsd += usd;
  }

  const byModel = Array.from(modelUsd.entries())
    .map(([model, usd]) => ({ model, usd }))
    .sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));

  return { bySurface, otherUsd, byModel, byType, contextWindow, tokenTypeUsd, fastModeUsd, standardModeUsd };
}

/** `period` (YYYY-MM) → the month's UTC bounds, the end capped at `now`. null when the month has not started. */
export function periodRange(period: string, now: Date = new Date()): { startingAt: string; endingAt: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const nextMonth = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  const end = nextMonth < now ? nextMonth : now;
  if (end <= start) return null;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { startingAt: iso(start), endingAt: iso(end) };
}

/** The key the cost endpoint is called with: the Analytics API key, else the Admin API key. */
export async function costApiKey(): Promise<string> {
  return (await getConfigValue('anthropicAnalyticsApiKey')) || (await getConfigValue('anthropicAdminApiKey'));
}

async function defaultFetchJson(url: string, apiKey: string): Promise<unknown> {
  return withBackoff(async () => {
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': COST_BETA,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic cost API error ${response.status}: ${text}`);
    }

    return response.json();
  });
}

/**
 * Fetches Anthropic's reported cost for `period` (YYYY-MM), every page, and
 * maps it to `EnterpriseCost`. Returns `null` when neither key is set or the
 * month has not started — callers should use `getEnterpriseCost` for the full
 * live/mock/none selector.
 */
export async function fetchEnterpriseCost(
  period: string,
  deps: { fetchJson?: (url: string) => Promise<unknown>; now?: Date } = {}
): Promise<EnterpriseCost | null> {
  const apiKey = await costApiKey();
  if (!apiKey) return null;
  const range = periodRange(period, deps.now);
  if (!range) return null;

  const fetchJson = deps.fetchJson ?? ((url: string) => defaultFetchJson(url, apiKey));

  const rows: RawCostRow[] = [];
  let page: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const url = new URL(COST_URL);
    url.searchParams.set('starting_at', range.startingAt);
    url.searchParams.set('ending_at', range.endingAt);
    for (const g of GROUP_BY) url.searchParams.append('group_by[]', g);
    url.searchParams.set('limit', '1000');
    if (page) url.searchParams.set('page', page);

    const body = (await fetchJson(url.toString())) as RawCostPage;
    rows.push(...(body?.data ?? []));
    const next = body?.has_more !== false && typeof body?.next_page === 'string' && body.next_page ? body.next_page : undefined;
    if (!next || next === page) break;
    page = next;
  }

  return mapCostRows(rows);
}

/**
 * Deterministic fixture used when `getEnterpriseCost` resolves to the mock
 * source. Numbers are internally consistent (bySurface + otherUsd, byModel,
 * byType, contextWindow and fast/standard mode all sum to the same $3,013.50
 * grand total, and tokenTypeUsd to byType.tokens) so cross-checks look sane in
 * a demo. Chat is kept non-zero so the Chat tile lights up.
 */
export const MOCK_ENTERPRISE_COST: EnterpriseCost = {
  bySurface: {
    chat: { usd: 842.5 },
    code: { usd: 1560.25 },
    cowork: { usd: 610.75 },
  },
  otherUsd: 0,
  byModel: [
    { model: 'claude-opus-4-6-20260115', usd: 1680.4 },
    { model: 'claude-sonnet-5-20260115', usd: 980.6 },
    { model: 'claude-haiku-4-5-20251001', usd: 352.5 },
  ],
  byType: { tokens: 2850.5, webSearch: 120.3, codeExecution: 42.7, sessionUsage: 0 },
  contextWindow: { standardUsd: 2703.5, longUsd: 310.0 },
  tokenTypeUsd: { uncachedInput: 900, cachedInput: 450.5, cacheCreation: 300, output: 1200 },
  fastModeUsd: 450.0,
  standardModeUsd: 2563.5,
};

export interface EnterpriseCostResult {
  data: EnterpriseCost | null;
  source: 'live' | 'mock' | 'none';
}

/**
 * The ONE entry point report assembly should call. Resolves the source:
 *   1. the Analytics API key or the Admin API key set → live fetch
 *   2. else `financeEnterpriseMock === 'true'` AND demo permitted → fixture
 *   3. else → dormant (`data: null`)
 *
 * Demo is permitted when NOT production, OR when `CCC_FINOPS_ALLOW_MOCK==='1'`
 * is explicitly set on the instance (the local Docker demo sets this in its
 * gitignored `.env`; a real customer instance never does, so production stays
 * blocked). Mock output is always stamped "DEMO DATA" in the UI regardless.
 */
export async function getEnterpriseCost(
  period: string,
  deps: { fetchJson?: (url: string) => Promise<unknown>; now?: Date } = {}
): Promise<EnterpriseCostResult> {
  if (await costApiKey()) {
    const data = await fetchEnterpriseCost(period, deps);
    return { data, source: 'live' };
  }

  const mockEnabled = (await getConfigValue('financeEnterpriseMock')) === 'true';
  const demoPermitted = process.env.NODE_ENV !== 'production' || process.env.CCC_FINOPS_ALLOW_MOCK === '1';
  if (mockEnabled && demoPermitted) {
    return { data: MOCK_ENTERPRISE_COST, source: 'mock' };
  }

  return { data: null, source: 'none' };
}

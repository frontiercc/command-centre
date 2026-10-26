// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Enterprise Admin API cost client — pulls org-level Anthropic API spend from
 * the Cost Report endpoint (see
 * https://platform.claude.com/docs/en/build-with-claude/admin-api) via the
 * Admin API key (`sk-ant-admin01`) and maps it into the `EnterpriseCost` shape
 * the FinOps v2 UI renders.
 *
 * ASSUMPTION (no live Enterprise Analytics key was available
 * to confirm against a real tenant; validate before trusting
 * this mapping in production):
 *
 *   The Anthropic Cost Report API returns bucketed usage/cost grouped by
 *   dimensions such as model, cost_type, context_window, token_type and
 *   service_tier — it has NO native "surface" (chat/code/cowork) dimension,
 *   since that split is a CCC concept, not an Anthropic one. We ASSUME the
 *   org tags each Workspace with a name that identifies one of CCC's three
 *   surfaces (e.g. a Workspace literally named "Chat", "Code" or "Cowork")
 *   and that the raw bucket carries that name through as `surface_label`.
 *   If a live tenant doesn't set this up, `mapRawToEnterpriseCost` degrades
 *   gracefully — any bucket with a missing/unrecognised `surface_label`
 *   falls into `chat` (Anthropic's own Console/API usage has always been
 *   chat-surface by default) rather than being silently dropped, so
 *   `bySurface` totals always reconcile with `byModel` / `byType` totals.
 *
 *   `amount_usd` is assumed pre-converted to USD (the real API returns a
 *   decimal string amount + currency code; a production implementation
 *   would parse/convert non-USD amounts before they reach this mapper).
 *
 *   `service_tier` is assumed to carry Anthropic's tier values
 *   ('priority' | 'standard' | 'batch'); we treat 'priority' as "fast mode"
 *   and fold 'standard' + 'batch' into "standard mode" (the EnterpriseCost
 *   shape has no separate batch bucket).
 */
import { getConfigValue } from '@/lib/config';
import { withBackoff } from '@/lib/ingestion/scheduler';
import type { CodeTokens } from '@/lib/finance/chargeback';

const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';

/** ASSUMED raw shape of one bucket in the Cost Report API response — see file header. */
interface RawCostBucket {
  /** ASSUMED workspace-name-derived surface tag — see file header. */
  surface_label?: string;
  model: string;
  cost_type: 'tokens' | 'web_search' | 'code_execution';
  context_window: '0-200k' | '200k-1M';
  token_type: 'uncached_input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens';
  service_tier: 'priority' | 'standard' | 'batch';
  amount_usd: number;
  token_count: number;
}

/** ASSUMED raw Cost Report API response envelope — see file header. */
interface RawCostReport {
  data: Array<{
    starting_at: string;
    ending_at: string;
    results: RawCostBucket[];
  }>;
}

export interface EnterpriseCost {
  bySurface: {
    chat: { usd: number; tokens: CodeTokens };
    code: { usd: number; tokens: CodeTokens };
    cowork: { usd: number; tokens: CodeTokens };
  };
  byModel: Array<{ model: string; usd: number }>;
  byType: { tokens: number; webSearch: number; codeExecution: number };
  /** 0-200k vs 200k-1M context window, in USD. */
  contextWindow: { standardUsd: number; longUsd: number };
  tokenTypes: { uncachedInput: number; cachedInput: number; cacheCreation: number; output: number };
  fastModeUsd: number;
  standardModeUsd: number;
}

function emptySurface(): { usd: number; tokens: CodeTokens } {
  return { usd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
}

function surfaceKey(label: string | undefined): 'chat' | 'code' | 'cowork' {
  const norm = (label ?? '').toLowerCase();
  if (norm === 'code') return 'code';
  if (norm === 'cowork') return 'cowork';
  return 'chat'; // unrecognised/missing label → chat (see ASSUMPTION above)
}

/** Maps the ASSUMED raw Cost Report response into `EnterpriseCost`. Never throws on unknown enum values — unrecognised buckets are counted in totals but skipped from the dimension they don't match. */
function mapRawToEnterpriseCost(raw: RawCostReport): EnterpriseCost {
  const bySurface = { chat: emptySurface(), code: emptySurface(), cowork: emptySurface() };
  const modelUsd = new Map<string, number>();
  const byType = { tokens: 0, webSearch: 0, codeExecution: 0 };
  const contextWindow = { standardUsd: 0, longUsd: 0 };
  const tokenTypes = { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 };
  let fastModeUsd = 0;
  let standardModeUsd = 0;

  const buckets = raw?.data?.flatMap((window) => window.results ?? []) ?? [];

  for (const bucket of buckets) {
    const usd = bucket.amount_usd ?? 0;
    const tokenCount = bucket.token_count ?? 0;

    // bySurface
    const surface = bySurface[surfaceKey(bucket.surface_label)];
    surface.usd += usd;
    switch (bucket.token_type) {
      case 'uncached_input_tokens':
        surface.tokens.input += tokenCount;
        break;
      case 'cache_read_input_tokens':
        surface.tokens.cacheRead += tokenCount;
        break;
      case 'cache_creation_input_tokens':
        surface.tokens.cacheWrite += tokenCount;
        break;
      case 'output_tokens':
        surface.tokens.output += tokenCount;
        break;
    }

    // byModel
    modelUsd.set(bucket.model, (modelUsd.get(bucket.model) ?? 0) + usd);

    // byType
    if (bucket.cost_type === 'tokens') byType.tokens += usd;
    else if (bucket.cost_type === 'web_search') byType.webSearch += usd;
    else if (bucket.cost_type === 'code_execution') byType.codeExecution += usd;

    // contextWindow
    if (bucket.context_window === '0-200k') contextWindow.standardUsd += usd;
    else if (bucket.context_window === '200k-1M') contextWindow.longUsd += usd;

    // tokenTypes (counts)
    switch (bucket.token_type) {
      case 'uncached_input_tokens':
        tokenTypes.uncachedInput += tokenCount;
        break;
      case 'cache_read_input_tokens':
        tokenTypes.cachedInput += tokenCount;
        break;
      case 'cache_creation_input_tokens':
        tokenTypes.cacheCreation += tokenCount;
        break;
      case 'output_tokens':
        tokenTypes.output += tokenCount;
        break;
    }

    // fast (priority) vs standard (standard + batch) mode
    if (bucket.service_tier === 'priority') fastModeUsd += usd;
    else standardModeUsd += usd;
  }

  const byModel = Array.from(modelUsd.entries())
    .map(([model, usd]) => ({ model, usd }))
    .sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));

  return { bySurface, byModel, byType, contextWindow, tokenTypes, fastModeUsd, standardModeUsd };
}

async function defaultFetchJson(url: string, apiKey: string): Promise<unknown> {
  return withBackoff(async () => {
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Enterprise Analytics cost API error ${response.status}: ${text}`);
    }

    return response.json();
  });
}

/**
 * Fetches org-level Anthropic API spend for `period` (YYYY-MM) from the
 * Admin API Cost Report endpoint and maps it to `EnterpriseCost`.
 * Returns `null` when no `anthropicAdminApiKey` is configured — callers
 * should use `getEnterpriseCost` for the full live/mock/none selector.
 */
export async function fetchEnterpriseCost(
  period: string,
  deps: { fetchJson?: (url: string) => Promise<unknown> } = {}
): Promise<EnterpriseCost | null> {
  const apiKey = await getConfigValue('anthropicAdminApiKey');
  if (!apiKey) return null;

  const fetchJson = deps.fetchJson ?? ((url: string) => defaultFetchJson(url, apiKey));

  const url =
    `${COST_REPORT_URL}?starting_at=${period}-01T00:00:00Z` +
    `&group_by[]=model&group_by[]=cost_type&group_by[]=context_window&group_by[]=token_type&group_by[]=service_tier`;

  const raw = (await fetchJson(url)) as RawCostReport;
  return mapRawToEnterpriseCost(raw);
}

/**
 * Deterministic fixture used when `getEnterpriseCost` resolves to the mock
 * source. Numbers are internally consistent (bySurface, byModel, byType,
 * contextWindow and fast/standard mode all sum to the same $3,013.50 grand
 * total) so the Phase-B UI's cross-checks look sane in a demo. Chat is kept
 * non-zero so the Chat tile lights up.
 */
export const MOCK_ENTERPRISE_COST: EnterpriseCost = {
  bySurface: {
    chat: { usd: 842.5, tokens: { input: 1_200_000, output: 380_000, cacheWrite: 45_000, cacheRead: 210_000 } },
    code: { usd: 1560.25, tokens: { input: 3_400_000, output: 890_000, cacheWrite: 120_000, cacheRead: 560_000 } },
    cowork: { usd: 610.75, tokens: { input: 980_000, output: 310_000, cacheWrite: 38_000, cacheRead: 175_000 } },
  },
  byModel: [
    { model: 'claude-opus-4-6-20260115', usd: 1680.4 },
    { model: 'claude-sonnet-5-20260115', usd: 980.6 },
    { model: 'claude-haiku-4-5-20251001', usd: 352.5 },
  ],
  byType: { tokens: 2850.5, webSearch: 120.3, codeExecution: 42.7 },
  contextWindow: { standardUsd: 2703.5, longUsd: 310.0 },
  tokenTypes: { uncachedInput: 5_580_000, cachedInput: 945_000, cacheCreation: 203_000, output: 1_580_000 },
  fastModeUsd: 450.0,
  standardModeUsd: 2563.5,
};

export interface EnterpriseCostResult {
  data: EnterpriseCost | null;
  source: 'live' | 'mock' | 'none';
}

/**
 * The ONE entry point report assembly should call. Resolves the source:
 *   1. `anthropicAdminApiKey` set → live fetch
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
  deps: { fetchJson?: (url: string) => Promise<unknown> } = {}
): Promise<EnterpriseCostResult> {
  const apiKey = await getConfigValue('anthropicAdminApiKey');
  if (apiKey) {
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

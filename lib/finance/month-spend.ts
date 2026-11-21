// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * This calendar month's spend for one person or a set of people, by product, against last month
 * at the same point. Spend stays on the calendar month everywhere, because Anthropic's limits and
 * FinOps run by month. Read from the same chargeback figures FinOps uses, never a second sum.
 */
import { buildChargeback, type ChargebackReport } from '@/lib/finance/chargeback';
import { currentPeriod } from '@/lib/finance/period';
import { priorPeriod } from '@/lib/finance/spend-review';

export interface MonthSpend {
  products: Array<{ label: string; usd: number }>;
  totalUsd: number;
  /** Last month's total, or null when there was none to compare with. */
  lastMonthUsd: number | null;
  /** How far through this month we are, so a part-month can be compared fairly. */
  elapsed: number;
  estimated: boolean;
}

export async function monthSpend(
  userIds: string[],
  vendor: 'all' | 'claude' | 'openai',
  nowS: number,
): Promise<MonthSpend | null> {
  if (userIds.length === 0) return null;
  const ids = new Set(userIds);
  const period = currentPeriod(nowS);
  // Only these people's rows are read; the whole organisation's spend is not needed here.
  const only = { userIds: [...ids] };
  const [cur, last] = await Promise.all([buildChargeback(period, nowS, {}, only), buildChargeback(priorPeriod(period), nowS, {}, only)]);
  const sum = (r: ChargebackReport) => {
    const t = { cowork: 0, code: 0, chatgpt: 0, codex: 0 };
    for (const u of [...r.costCentres.flatMap(c => c.users), ...r.unallocated.users]) {
      if (!ids.has(u.userId)) continue;
      t.cowork += u.coworkUsd; t.code += u.codeUsd; t.chatgpt += u.chatgptUsd ?? 0; t.codex += u.codexUsd ?? 0;
    }
    return t;
  };
  const a = sum(cur), b = sum(last);
  const pick = (t: typeof a) => [
    ...(vendor !== 'openai' ? [{ label: 'Claude Cowork', usd: t.cowork }, { label: 'Claude Code', usd: t.code }] : []),
    ...(vendor !== 'claude' ? [{ label: 'ChatGPT', usd: t.chatgpt }, { label: 'Codex', usd: t.codex }] : []),
  ];
  const lastTotal = pick(b).reduce((s, p) => s + p.usd, 0);
  return {
    products: pick(a).filter(p => p.usd > 0),
    totalUsd: pick(a).reduce((s, p) => s + p.usd, 0),
    lastMonthUsd: lastTotal > 0 ? lastTotal : null,
    elapsed: Math.min(1, Math.max(0.01, (nowS - cur.periodStart) / (cur.periodEnd - cur.periodStart))),
    estimated: cur.estimated,
  };
}

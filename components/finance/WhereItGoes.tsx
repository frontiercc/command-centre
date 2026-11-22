// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps "Where it goes": the month's spend split by product as one bar, with
 * a legend line per product (spend and share of the total). Purely
 * presentational: every figure is read from the already-fetched
 * ChargebackReport.surfaces, the same figures and rounding the by-surface
 * tiles used. A product with no measured spend is never drawn as $0.
 */
import type { ReactNode } from 'react';
import { Panel } from '@/components/precision/ui';
import { PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { usdWhole } from '@/lib/finance/spend-review-format';
import { BASIS_TEXT, type SurfaceSpend, type SurfaceSummary } from '@/components/finance/SurfaceTiles';

const fmtUsd = usdWhole;

const fmtTokensCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
  : String(n);

const tokensTotal = (t: SurfaceSpend['tokens']) => t.input + t.output + t.cacheWrite + t.cacheRead;

interface Item {
  key: string;
  label: string;
  colour: string;
  spend: SurfaceSpend;
}

/** Share of the total, rounded as the tiles rounded it; null when there is no total. */
function sharePct(usd: number, totalUsd: number): number | null {
  return totalUsd > 0 ? Math.round((usd / totalUsd) * 100) : null;
}

export default function WhereItGoes({ surfaces, openaiOnly = false, right, children }: {
  surfaces: SurfaceSummary;
  openaiOnly?: boolean;
  /** Header extras: the token count and the pricing basis. */
  right?: ReactNode;
  /** Anything to show under the legend. */
  children?: ReactNode;
}) {
  const openai = surfaces.chatgpt && surfaces.codex ? { chatgpt: surfaces.chatgpt, codex: surfaces.codex } : null;
  const claude = !openai || !openaiOnly;
  const items: Item[] = [
    ...(claude ? [
      { key: 'cowork', label: openai ? 'Claude Cowork' : 'Cowork', colour: PRODUCT_COLOR.claude_cowork, spend: surfaces.cowork },
      { key: 'code', label: openai ? 'Claude Code' : 'Code', colour: PRODUCT_COLOR.claude_code, spend: surfaces.code },
      { key: 'chat', label: openai ? 'Claude Chat' : 'Chat', colour: PRODUCT_COLOR.claude_chat, spend: surfaces.chat },
    ] : []),
    ...(openai ? [
      { key: 'chatgpt', label: 'ChatGPT', colour: PRODUCT_COLOR.chatgpt_chat, spend: openai.chatgpt },
      { key: 'codex', label: 'Codex', colour: PRODUCT_COLOR.codex, spend: openai.codex },
    ] : []),
  ];
  const totalUsd = surfaces.total.usd;
  const measured = items.filter(i => i.spend.basis !== 'dormant' && i.spend.usd !== null);
  const notMeasured = items.filter(i => !measured.includes(i));
  const drawn = measured.filter(i => (i.spend.usd ?? 0) > 0);

  const describe = (i: Item) => {
    const usd = i.spend.usd ?? 0;
    const share = sharePct(usd, totalUsd);
    return `${i.label} ${fmtUsd(usd)}${share != null ? ` · ${share}%` : ''}`;
  };

  return (
    <Panel title="Where it goes" right={right}>
      <div className="flex flex-col gap-3">
        <div
          className="w-full h-2.5 rounded-full bg-[#F2F2F2] overflow-hidden flex gap-px"
          role="img"
          aria-label={drawn.length > 0 ? `Spend by product: ${drawn.map(describe).join(', ')}` : 'No measured spend by product'}
        >
          {totalUsd > 0 && drawn.map(i => (
            <div
              key={i.key}
              className="h-full shrink-0"
              style={{ width: `${((i.spend.usd ?? 0) / totalUsd) * 100}%`, background: i.colour }}
            />
          ))}
        </div>
        {measured.length > 0 && (
          <div className="flex gap-x-5 gap-y-1 flex-wrap text-[13px] text-[#4D4D4D] tabular-nums">
            {measured.map(i => {
              const usd = i.spend.usd ?? 0;
              const share = sharePct(usd, totalUsd);
              const tokens = tokensTotal(i.spend.tokens);
              return (
                <span
                  key={i.key}
                  className="inline-flex items-center gap-1.5"
                  title={`${i.label}: ${tokens > 0 ? `${fmtTokensCompact(tokens)} tokens` : 'no tokens'}, ${BASIS_TEXT[i.spend.basis]}`}
                >
                  <span className="w-2.5 h-2.5 rounded-[2px] shrink-0" style={{ background: i.colour }} aria-hidden="true" />
                  {i.label} <span className="text-[#0A0A0A] font-medium">{fmtUsd(usd)}</span>
                  {share != null && <span className="text-[#8F8F8F]">· {share}%</span>}
                </span>
              );
            })}
          </div>
        )}
        {/* A product not captured here is simply left out; OpenAI products still waiting on cost records are named. */}
        {notMeasured.some(i => i.spend.basis !== 'dormant') && (
          <p className="m-0 text-[12px] text-[#8F8F8F]">
            {notMeasured.filter(i => i.spend.basis !== 'dormant').map(i => `${i.label}: no cost records from OpenAI yet.`).join(' ')}
          </p>
        )}
        {children}
      </div>
    </Panel>
  );
}

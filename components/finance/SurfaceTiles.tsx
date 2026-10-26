// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps headline "by surface" row — Chat (dormant) / Code (estimate) /
 * Cowork (actual) / Total. Purely presentational; all numbers come straight
 * from the already-fetched ChargebackReport.surfaces — no new data fetch.
 */
import { Strip, Figure } from '@/components/precision/ui';

interface CodeTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

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

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtTokensCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
  : String(n);

const tokensTotal = (t: CodeTokens) => t.input + t.output + t.cacheWrite + t.cacheRead;

const BASIS_TEXT: Record<SurfaceBasis, string> = {
  dormant: 'dormant',
  estimate: 'estimated at list rates',
  actual: 'actual, per request',
};

function shareOf(usd: number | null, totalUsd: number): string | null {
  if (usd === null || totalUsd <= 0) return null;
  return `${Math.round((usd / totalUsd) * 100)}%`;
}

function SurfaceFigure({ label, spend, totalUsd }: { label: string; spend: SurfaceSpend; totalUsd: number }) {
  if (spend.basis === 'dormant') {
    return (
      <Figure
        label={label}
        value={<span className="text-[#B3B3B3]">—</span>}
        sub="Dormant: Chat spend is not captured on this deployment."
      />
    );
  }
  const total = tokensTotal(spend.tokens);
  const share = shareOf(spend.usd, totalUsd);
  const parts = [
    share,
    total > 0 ? `${fmtTokensCompact(total)} tokens` : 'no tokens',
    BASIS_TEXT[spend.basis],
  ].filter(Boolean);
  // A non-dormant surface always carries a figure; null never renders as $0.
  return <Figure label={label} value={spend.usd === null ? '—' : fmtUsd(spend.usd)} sub={parts.join(' · ')} />;
}

export default function SurfaceTiles({ surfaces }: { surfaces: SurfaceSummary }) {
  const totalTokens = tokensTotal(surfaces.total.tokens);
  return (
    <Strip cols={4}>
      <SurfaceFigure label="Cowork" spend={surfaces.cowork} totalUsd={surfaces.total.usd} />
      <SurfaceFigure label="Code" spend={surfaces.code} totalUsd={surfaces.total.usd} />
      <SurfaceFigure label="Chat" spend={surfaces.chat} totalUsd={surfaces.total.usd} />
      <Figure
        label="Total"
        value={fmtUsd(surfaces.total.usd)}
        sub={totalTokens > 0 ? `${fmtTokensCompact(totalTokens)} tokens` : 'no tokens'}
      />
    </Strip>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps "charts A" row — spend trend, month-end projection, spend
 * concentration. Spend trend + concentration are pure presentational
 * wrappers around existing deterministic helpers (lib/finance/trend,
 * lib/finance/product-split over lib/pulse/code/concentration); the month-end
 * projection is computed server-side (`lib/finance/finops-projection.ts`, an
 * honest MTD run rate) and passed straight through — no client-side
 * recomputation. The trend and concentration bars are split by product
 * (Claude Code, Claude Cowork, ChatGPT, Codex) in the product colours.
 */
import { Panel, Tag, Bar, Muted, cx } from '@/components/precision/ui';
import type { SpendProjection } from '@/lib/pulse/code/projection';
import { MIN_PROJECTION_DAYS } from '@/lib/finance/finops-projection';
import {
  concentrationByProduct, productsPresent, legendGroups, partsOfRow,
  PRODUCT_FILL, PRODUCT_NAME, PRODUCT_SHORT,
  type FinopsProduct, type ProductParts, type ProductRow,
} from '@/lib/finance/product-split';

export interface SpendTrendPoint {
  period: string;
  usd: number | null;
  /** Spend by product, adding up to `usd`. Absent from an older response: drawn as one Claude part. */
  parts?: ProductParts;
}

export interface SpendTrend {
  series: SpendTrendPoint[];
  render: boolean;
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtPct = (n: number) => `${Math.round(n * 100)}%`;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09" → "Sep 2026"; anything else passes through. */
function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return y && m >= 1 && m <= 12 ? `${MONTH_SHORT[m - 1]} ${y}` : period;
}

/** "2026-09" → "S", for the axis under each bar. */
function periodInitial(period: string): string {
  const m = Number(period.split('-')[1]);
  return m >= 1 && m <= 12 ? MONTH_SHORT[m - 1].charAt(0) : '';
}

/** A point's parts, or the whole month as undivided Claude when a response predates the split. */
function pointParts(p: SpendTrendPoint): ProductParts {
  if (p.parts) return p.parts;
  return p.usd != null && p.usd > 0 ? { claude: p.usd } : {};
}

/** Hover text for a month: each product's part, then the total. */
function monthTitle(p: SpendTrendPoint, products: FinopsProduct[]): string {
  if (p.usd === null) return `${periodLabel(p.period)}: no data`;
  const parts = pointParts(p);
  const lines = products.filter(k => (parts[k] ?? 0) > 0).map(k => `${PRODUCT_NAME[k]}: ${fmtUsd(parts[k]!)}`);
  return [periodLabel(p.period), ...lines, `Total: ${fmtUsd(p.usd)}`].join('\n');
}

/** Coloured key, products grouped under Claude and OpenAI. */
function ProductLegend({ products }: { products: FinopsProduct[] }) {
  if (products.length === 0) return null;
  return (
    <div className="flex gap-x-5 gap-y-1 flex-wrap text-[12px] text-[#8F8F8F]">
      {legendGroups(products).map(g => (
        <span key={g.vendor} className="flex items-center gap-2.5 flex-wrap">
          <span className="text-[#4D4D4D] font-medium">{g.label}</span>
          {g.products.map(k => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: PRODUCT_FILL[k] }} aria-hidden="true" />
              {PRODUCT_SHORT[k]}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/**
 * One stacked bar per month, a segment per product in the product colours. A
 * null month is an empty slot with a faint baseline, never a zero bar: no
 * recorded spend is not the same as zero spend. All of it is measured spend.
 */
function MonthBars({ series, products }: { series: SpendTrendPoint[]; products: FinopsProduct[] }) {
  const max = Math.max(0, ...series.map(p => p.usd ?? 0));
  return (
    <div>
      <div className="flex items-end gap-1.5 h-[120px] border-b border-[#EAEAEA]" role="img" aria-label="Spend by month, split by product">
        {series.map(p => {
          const h = p.usd === null || max <= 0 ? 0 : Math.max(1, Math.round((p.usd / max) * 100));
          const parts = pointParts(p);
          const shown = products.filter(k => (parts[k] ?? 0) > 0);
          const sum = shown.reduce((a, k) => a + parts[k]!, 0);
          return (
            <div key={p.period} className="flex-1 h-full flex flex-col justify-end" title={monthTitle(p, products)}>
              {p.usd === null
                ? <div className="h-1 rounded-full bg-[#F2F2F2]" />
                : (
                  <div className="flex flex-col-reverse rounded-t-[2px] overflow-hidden" style={{ height: `${h}%` }}>
                    {sum > 0 && shown.map(k => (
                      <div key={k} className="shrink-0" style={{ height: `${(parts[k]! / sum) * 100}%`, background: PRODUCT_FILL[k] }} />
                    ))}
                  </div>
                )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1">
        {series.map(p => (
          <span key={p.period} className="flex-1 basis-0 text-center text-[11px] text-[#8F8F8F]">{periodInitial(p.period)}</span>
        ))}
      </div>
    </div>
  );
}

function SpendTrendCard({ trend, openaiOnly }: { trend: SpendTrend | null; openaiOnly: boolean }) {
  if (!trend || !trend.render) {
    return (
      <Panel title="Spend trend">
        <Muted>Not enough history yet. The trend appears once 3 or more months have recorded spend.</Muted>
      </Panel>
    );
  }
  const latest = trend.series[trend.series.length - 1];
  const first = trend.series[0];
  const products = productsPresent(trend.series.map(pointParts), { openaiOnly });
  return (
    <Panel
      title="Spend trend"
      subtitle={`${periodLabel(first.period)} to ${periodLabel(latest.period)}`}
      right={<span className="text-[13px] text-[#666666] tabular-nums">{latest.usd != null ? fmtUsd(latest.usd) : '—'} <span className="text-[#8F8F8F]">this month</span></span>}
    >
      <div className="flex flex-col gap-3">
        <MonthBars series={trend.series} products={products} />
        <ProductLegend products={products} />
      </div>
    </Panel>
  );
}

function ProjectionCard({ monthToDate, projection, byVendor, openaiOnly }: {
  monthToDate: boolean;
  projection: SpendProjection | null;
  byVendor: { claudeUsd: number; openaiUsd: number } | null;
  openaiOnly: boolean;
}) {
  if (!monthToDate || !projection) {
    return (
      <Panel title="Month-end projection">
        <Muted>Only shown for the current, in-progress month.</Muted>
      </Panel>
    );
  }
  if (projection.daysElapsed < MIN_PROJECTION_DAYS) {
    return (
      <Panel title="Month-end projection" right={<Tag tone="judged">Estimate</Tag>}>
        <div className="flex flex-col gap-2">
          <span className="text-[14px] text-[#4D4D4D]">Too early in the month to project.</span>
          <span className="text-[13px] text-[#666666] tabular-nums">Day {projection.daysElapsed} of {projection.daysInMonth}</span>
          <Bar pct={(projection.daysElapsed / Math.max(1, projection.daysInMonth)) * 100} tone="measured" height={6} />
          <Muted>Shown from day {MIN_PROJECTION_DAYS}, once a run rate means something.</Muted>
        </div>
      </Panel>
    );
  }
  // Split only with both vendors' spend this month (and Claude shown): otherwise the plain total.
  const split = byVendor && !openaiOnly && byVendor.claudeUsd > 0 && byVendor.openaiUsd > 0 ? byVendor : null;
  return (
    <Panel title="Month-end projection" right={<Tag tone="judged">Estimate</Tag>}>
      <div className="flex flex-col gap-2">
        {split ? (
          <p className="m-0 flex flex-col gap-0.5 tabular-nums">
            <span className="text-[14px] text-[#4D4D4D]">
              Projected <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] text-[#2451F3]">{fmtUsd(projection.projected)}</span>:
            </span>
            <span className="text-[13px] text-[#4D4D4D]">Claude {fmtUsd(split.claudeUsd)} · ChatGPT and Codex {fmtUsd(split.openaiUsd)}</span>
          </p>
        ) : (
          <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#2451F3]">{fmtUsd(projection.projected)}</span>
        )}
        <span className="text-[13px] text-[#666666] tabular-nums">Day {projection.daysElapsed} of {projection.daysInMonth}</span>
        <Bar pct={(projection.daysElapsed / Math.max(1, projection.daysInMonth)) * 100} tone="measured" height={6} />
        <Muted>{split ? 'Run-rate estimate: Claude spend and ChatGPT and Codex spend, each extrapolated from its own month-to-date figure.' : 'Run-rate estimate, extrapolated from month-to-date spend.'}</Muted>
      </div>
    </Panel>
  );
}

/** A share bar split into product segments, each as wide as its share of all spend. */
function ProductShareBar({ parts, products }: { parts: ProductParts; products: FinopsProduct[] }) {
  return (
    <div className="w-full h-[3px] rounded-full bg-[#F2F2F2] overflow-hidden flex">
      {products.filter(k => (parts[k] ?? 0) > 0).map(k => (
        <div key={k} className="h-full shrink-0" style={{ width: `${Math.min(100, parts[k]! * 100)}%`, background: PRODUCT_FILL[k] }} />
      ))}
    </div>
  );
}

function ConcentrationCard({ costCentres, openaiOnly }: { costCentres: ProductRow[]; openaiOnly: boolean }) {
  const tiers = concentrationByProduct(costCentres);
  if (!tiers) return null;
  const products = productsPresent(costCentres.map(partsOfRow), { openaiOnly });
  return (
    <Panel title="Spend concentration" subtitle="Share of total spend by top cost centres" flush>
      <div className="py-1">
        {tiers.map(t => (
          <div
            key={t.topN}
            className="px-4 py-2 flex flex-col gap-1 border-t border-[#F2F2F2] first:border-t-0"
            title={[`Top ${t.topN}: ${fmtPct(t.share)}`, ...products.filter(k => (t.parts[k] ?? 0) > 0).map(k => `${PRODUCT_NAME[k]}: ${fmtPct(t.parts[k]!)}`)].join('\n')}
          >
            <div className="flex items-baseline gap-2 text-[14px]">
              <span className="text-[#0A0A0A]">Top {t.topN}</span>
              <span className="ml-auto text-[13px] text-[#666666] tabular-nums">{fmtPct(t.share)}</span>
            </div>
            <ProductShareBar parts={t.parts} products={products} />
          </div>
        ))}
        <div className="px-4 pt-2 pb-1 border-t border-[#F2F2F2]">
          <ProductLegend products={products} />
        </div>
      </div>
    </Panel>
  );
}

export default function FinopsCharts({
  trend,
  monthToDate,
  projection,
  projectionByVendor = null,
  costCentres,
  openaiOnly = false,
}: {
  trend: SpendTrend | null;
  monthToDate: boolean;
  projection: SpendProjection | null;
  /** Claude's and OpenAI's projected month-end spend; null without the vendor split. */
  projectionByVendor?: { claudeUsd: number; openaiUsd: number } | null;
  /** Each cost centre's total and per-product figures. */
  costCentres: ProductRow[];
  /** Only OpenAI connected: Claude's products are left out of the bars and keys. */
  openaiOnly?: boolean;
}) {
  const concentration = concentrationByProduct(costCentres);
  return (
    <div className={cx('grid grid-cols-1 gap-4', concentration ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]')}>
      <SpendTrendCard trend={trend} openaiOnly={openaiOnly} />
      <ProjectionCard monthToDate={monthToDate} projection={projection} byVendor={projectionByVendor} openaiOnly={openaiOnly} />
      <ConcentrationCard costCentres={costCentres} openaiOnly={openaiOnly} />
    </div>
  );
}

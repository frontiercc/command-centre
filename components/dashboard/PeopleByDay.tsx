// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Who is using it each day?" One line per product, every line counting people a day,
 * never prompts, so the lines can be compared. Weekends are shaded; today, still in progress, is
 * drawn dashed.
 *
 * The plot stretches to whatever height the row needs, so this panel always matches the one
 * beside it. Only the lines and the shading stretch: every label is HTML at a fixed size, and the
 * lines keep their thickness, so nothing distorts.
 */
import { Panel, Tag } from '@/components/precision/ui';
import { PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import type { Product, ProductCounts } from '@/lib/dashboard/vendor';

export default function PeopleByDay({ days, products, activeThisWeek, activeLastWeek, productNames }: {
  days: Array<{ date: string; products: ProductCounts }>;
  products: readonly Product[];
  activeThisWeek: number;
  activeLastWeek: number;
  /** The products in words, e.g. "Claude or ChatGPT". */
  productNames: string;
}) {
  const n = days.length;
  const shown = products.filter(p => days.some(d => d.products[p.id] > 0));
  const max = Math.max(4, ...days.flatMap(d => shown.map(p => d.products[p.id])));
  // The plot is drawn in a 0–100 box on both axes and stretched by CSS.
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const y = (v: number) => (1 - v / max) * 100;
  const tickTop = Math.ceil(max / 5) * 5;
  const ticks = [0, Math.round(tickTop / 2), tickTop].filter((t, i, a) => a.indexOf(t) === i && t <= max * 1.05);
  const yIdx = n >= 2 ? n - 2 : n - 1;
  const lead = shown.length > 0 ? [...shown].sort((a, b) => days[yIdx].products[b.id] - days[yIdx].products[a.id])[0] : null;
  const diff = activeThisWeek - activeLastWeek;
  const change = diff === 0 ? 'the same as' : diff > 0 ? `${diff} more than` : `${-diff} fewer than`;
  const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const label = (d: string) => { const dt = new Date(`${d}T00:00:00Z`); return `${dt.getUTCDate()} ${dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`; };
  const half = n > 1 ? 50 / (n - 1) : 50;

  return (
    <Panel
      title="Who is using it each day?"
      badge={<Tag tone="measured">Measured</Tag>}
      right={<span className="text-[13px] text-[#8F8F8F]">Last 14 days</span>}
      className="h-full flex flex-col"
      bodyClassName="flex-1 flex flex-col"
    >
      <p className="m-0 mb-3 text-[15px] leading-6 text-[#0A0A0A]">
        <b className="font-semibold">{activeThisWeek} people</b> used {productNames} in the last 7 days, {change} the week before.
        {lead ? <> {lead.label} has the most people each day: <b className="font-semibold">{days[yIdx].products[lead.id]}</b> yesterday.</> : null}
      </p>
      {shown.length === 0 ? (
        <p className="m-0 text-[13px] text-[#8F8F8F]">No activity in the last 14 days.</p>
      ) : (
        <>
          <div className="flex-1 min-h-[130px] flex">
            <div className="relative w-7 shrink-0">
              {ticks.map(t => (
                <span key={t} className="absolute right-1.5 -translate-y-1/2 text-[11px] leading-none text-[#8F8F8F] tabular-nums" style={{ top: `${y(t)}%` }}>{t}</span>
              ))}
            </div>
            <div className="relative flex-1">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" role="img" aria-label="People a day by product, last 14 days">
                {days.map((d, i) => (weekday(d.date) === 0 || weekday(d.date) === 6)
                  ? <rect key={`w${i}`} x={Math.max(0, x(i) - half)} y={0} width={half * 2} height={100} fill="#F2F2F4" />
                  : null)}
                {ticks.map(t => (
                  <line key={t} x1={0} x2={100} y1={y(t)} y2={y(t)} stroke="#EDEDED" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                {shown.map(p => {
                  const pts = days.map((d, i) => `${x(i)},${y(d.products[p.id])}`);
                  return (
                    <g key={p.id} stroke={PRODUCT_COLOR[p.id]} strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke">
                      <polyline points={pts.slice(0, n - 1).join(' ')} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                      <polyline points={pts.slice(n - 2).join(' ')} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
          <div className="relative h-4 mt-1 ml-7">
            {days.map((d, i) => (i % 2 === 1 || i === n - 1) ? (
              <span key={`l${i}`} className="absolute -translate-x-1/2 text-[11px] leading-4 text-[#8F8F8F] whitespace-nowrap" style={{ left: `${x(i)}%` }}>
                {i === n - 1 ? 'Today' : label(d.date)}
              </span>
            ) : null)}
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[12px] text-[#666666]">
        {shown.map(p => (
          <span key={p.id} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: PRODUCT_COLOR[p.id] }} />{p.label}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] bg-[#F2F2F4] border border-[#E4E4E7]" />Weekend</span>
      </div>
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Every line counts people, never prompts, so the products can be compared. A person counts once a day for each product they used. Today is still in progress, so its line is dashed.
      </p>
    </Panel>
  );
}

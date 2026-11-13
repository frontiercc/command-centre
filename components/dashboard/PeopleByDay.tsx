// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Who is using it each day?" (replaces the 14-day adoption trend). One line per
 * product, every line counting people a day, never prompts, so the lines can be compared.
 * Weekends are shaded; today, still in progress, is drawn dashed.
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
  const W = 640, H = 200, left = 34, right = 10, top = 14, bottom = 22;
  const n = days.length;
  const shown = products.filter(p => days.some(d => d.products[p.id] > 0));
  const max = Math.max(4, ...days.flatMap(d => shown.map(p => d.products[p.id])));
  const step = (W - left - right) / Math.max(1, n - 1);
  const x = (i: number) => left + i * step;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const tickTop = Math.ceil(max / 5) * 5;
  const ticks = [0, Math.round(tickTop / 2), tickTop].filter((t, i, a) => a.indexOf(t) === i && t <= max * 1.05);
  const yIdx = n >= 2 ? n - 2 : n - 1;
  const lead = shown.length > 0 ? [...shown].sort((a, b) => days[yIdx].products[b.id] - days[yIdx].products[a.id])[0] : null;
  const diff = activeThisWeek - activeLastWeek;
  const change = diff === 0 ? 'the same as' : diff > 0 ? `${diff} more than` : `${-diff} fewer than`;
  const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const label = (d: string) => { const dt = new Date(`${d}T00:00:00Z`); return `${dt.getUTCDate()} ${dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`; };

  return (
    <Panel title="Who is using it each day?" badge={<Tag tone="measured">Measured</Tag>} right={<span className="text-[13px] text-[#8F8F8F]">Last 14 days</span>} className="h-full">
      <p className="m-0 mb-3 text-[15px] leading-6 text-[#0A0A0A]">
        <b className="font-semibold">{activeThisWeek} people</b> used {productNames} in the last 7 days, {change} the week before.
        {lead ? <> {lead.label} has the most people each day: <b className="font-semibold">{days[yIdx].products[lead.id]}</b> yesterday.</> : null}
      </p>
      {shown.length === 0 ? (
        <p className="m-0 text-[13px] text-[#8F8F8F]">No activity in the last 14 days.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="People a day by product, last 14 days">
          {days.map((d, i) => (weekday(d.date) === 0 || weekday(d.date) === 6)
            ? <rect key={`w${i}`} x={x(i) - step / 2} y={top} width={step} height={H - top - bottom} fill="#F2F2F4" />
            : null)}
          {ticks.map(t => (
            <g key={t}>
              <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke="#EDEDED" />
              <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#8F8F8F">{t}</text>
            </g>
          ))}
          {shown.map(p => {
            const pts = days.map((d, i) => `${x(i)},${y(d.products[p.id])}`);
            return (
              <g key={p.id}>
                <polyline points={pts.slice(0, n - 1).join(' ')} fill="none" stroke={PRODUCT_COLOR[p.id]} strokeWidth={2.4} strokeLinejoin="round" />
                <polyline points={pts.slice(n - 2).join(' ')} fill="none" stroke={PRODUCT_COLOR[p.id]} strokeWidth={2.4} strokeDasharray="4 3" />
              </g>
            );
          })}
          {days.map((d, i) => (i % 2 === 1 || i === n - 1)
            ? <text key={`l${i}`} x={x(i)} y={H - 5} textAnchor="middle" fontSize="11" fill="#8F8F8F">{i === n - 1 ? 'Today' : label(d.date)}</text>
            : null)}
        </svg>
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

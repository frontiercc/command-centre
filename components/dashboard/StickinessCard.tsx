// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "How often do people come back?" (was Product stickiness, DAU/MAU). One row of dots
 * per product: one dot per person who used it in the last 30 days, filled for those who use it
 * on a typical day (the 7-day average of daily users). Above 60 people a dot stands for several.
 */
import { useEffect, useState } from 'react';
import { Panel, Tag } from '@/components/precision/ui';
import { PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { dashboardProducts, productsShown, type ProductId, type Vendor } from '@/lib/dashboard/vendor';

interface SurfaceStickiness {
  avgDau: number;
  mau: number;
  stickiness: number | null;
}

interface StickinessData {
  products: Record<ProductId, SurfaceStickiness>;
  computedAt: number;
}

const MAX_DOTS = 60;

export default function StickinessCard({ vendor = 'all', openaiPresent = false, officeShown = true }: { vendor?: Vendor; openaiPresent?: boolean; officeShown?: boolean }) {
  const [data, setData] = useState<StickinessData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/pulse/stickiness')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading || !data) return null;

  const rows = dashboardProducts(productsShown(vendor, openaiPresent), officeShown)
    .map(p => ({ ...p, s: data.products[p.id] }))
    .filter(r => r.s && r.s.mau > 0);
  const biggest = Math.max(1, ...rows.map(r => r.s.mau));
  const per = biggest > MAX_DOTS ? Math.ceil(biggest / MAX_DOTS) : 1;
  const habit = [...rows].filter(r => r.s.mau >= 5 && r.s.stickiness !== null).sort((a, b) => (b.s.stickiness ?? 0) - (a.s.stickiness ?? 0))[0];

  return (
    <Panel title="How often do people come back?" badge={<Tag tone="measured">Measured</Tag>} right={<span className="text-[13px] text-[#8F8F8F]">Last 30 days</span>} className="h-full">
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-[#8F8F8F]">No one has used these products in the last 30 days.</p>
      ) : (
        <>
          {habit && (
            <p className="m-0 mb-3 text-[14px] leading-5 text-[#0A0A0A]">
              People come back to {habit.label} most: <b className="font-semibold">{Math.round(habit.s.avgDau)} of its {habit.s.mau}</b> users this month use it on a typical day.
            </p>
          )}
          <div className="flex flex-col gap-2.5">
            {rows.map(r => {
              const total = Math.ceil(r.s.mau / per);
              const daily = Math.min(total, Math.round(r.s.avgDau / per));
              return (
                <div key={r.id} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)_64px] gap-3 items-center text-[13px]">
                  <span className="truncate text-[#333333]">{r.label}</span>
                  <span className="flex flex-wrap gap-[3px]" aria-label={`${Math.round(r.s.avgDau)} of ${r.s.mau} on a typical day`}>
                    {Array.from({ length: total }, (_, i) => (
                      <span key={i} className="w-[9px] h-[9px] rounded-full" style={{ background: i < daily ? PRODUCT_COLOR[r.id] : '#E4E4E7' }} />
                    ))}
                  </span>
                  <span className="text-right tabular-nums text-[#0A0A0A]">{Math.round(r.s.avgDau)} of {r.s.mau}</span>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 mt-3 text-[12px] text-[#666666]">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: rows[0] ? PRODUCT_COLOR[rows[0].id] : '#1F6F8B' }} />In the product&apos;s colour: uses it on a typical day</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#E4E4E7]" />Used it this month, not daily</span>
          </div>
        </>
      )}
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        {per === 1 ? 'One dot per person who used the product in the last 30 days.' : `Each dot is ${per} people who used the product in the last 30 days.`} A typical day is the average of the last 7 days.
      </p>
    </Panel>
  );
}

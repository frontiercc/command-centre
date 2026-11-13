// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Which departments are using it?" (was the department adoption heatmap). One slim
 * bar per department: the share of the department active in the last 7 days, against the
 * admin-set target. Only a department below the target is coloured (amber). Two columns, so the
 * panel stays short.
 */
import { Panel, Muted, Tag } from '@/components/precision/ui';
import type { Product, ProductCounts } from '@/lib/dashboard/vendor';
import { DASH } from '@/components/dashboard/QuestionCard';

interface DeptStats {
  department: string;
  user_count: number;
  active_users: number;
  /** People who used each product in the last 7 days. */
  products: ProductCounts;
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export default function DepartmentHeatmap({ data: all, targetPct, productNames = 'Claude' }: { data: DeptStats[]; products?: readonly Product[]; targetPct: number | null; /** The products in words for the heading, e.g. "Claude and ChatGPT". */ productNames?: string }) {
  const rows = all
    .filter(d => d.user_count > 0)
    .map(d => ({ ...d, active: d.active_users / d.user_count }))
    .sort((a, b) => b.active - a.active);
  if (rows.length === 0) {
    return (
      <Panel title={`Which departments are using ${productNames}?`}>
        <Muted>No department data yet. Set people&apos;s departments on the User Insights page.</Muted>
      </Panel>
    );
  }
  const target = targetPct !== null ? targetPct / 100 : null;
  const below = target === null ? [] : rows.filter(r => r.active < target);
  const top = rows[0];
  const answer = target === null
    ? <><b className="font-semibold">{top.department}</b> uses it most: {Math.round(top.active * 100)}% of the department in the last 7 days.</>
    : below.length === 0
      ? <>Every department is at or above your <b className="font-semibold">{targetPct}%</b> target.</>
      : below.length <= 3
        ? <><b className="font-semibold">{list(below.map(b => b.department))}</b> {below.length === 1 ? 'is' : 'are'} below your {targetPct}% target.</>
        : <><b className="font-semibold">{below.length} of {rows.length}</b> departments are below your {targetPct}% target.</>;

  return (
    <Panel
      title={`Which departments are using ${productNames}?`}
      badge={<Tag tone="neutral">Measured</Tag>}
      right={<span className="text-[13px] text-[#8F8F8F]">Last 7 days</span>}
    >
      <p className="m-0 mb-2 text-[14px] leading-[22px] text-[#1A1A1A]">{answer}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        {rows.map(d => {
          const isBelow = target !== null && d.active < target;
          return (
            <div key={d.department} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_44px] gap-2.5 items-center py-[3px] text-[13px]" title={`${d.active_users} of ${d.user_count} people active`}>
              <span className="truncate text-[#333333]">{d.department}</span>
              <span className="relative h-[6px] rounded-[3px] bg-[#F1F1F3]">
                <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${Math.max(1, d.active * 100)}%`, background: isBelow ? '#DC8A00' : DASH }} />
                {target !== null && <span className="absolute -top-1 -bottom-1 border-l-[1.5px] border-dashed border-[#555555]" style={{ left: `${target * 100}%` }} />}
              </span>
              <span className={`text-right tabular-nums ${isBelow ? 'font-semibold text-[#B54708]' : 'text-[#0A0A0A]'}`}>{Math.round(d.active * 100)}%</span>
            </div>
          );
        })}
      </div>
      <p className="m-0 mt-2.5 pt-2 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Each bar is the share of the department active in the last 7 days.{target !== null ? ` The dashed line is your ${targetPct}% target, set in Admin → System; departments below it are amber.` : ''}
      </p>
    </Panel>
  );
}

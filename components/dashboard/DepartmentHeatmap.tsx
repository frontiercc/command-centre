// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Which departments are using it?" (was the department adoption heatmap). The grid
 * stays; each cell is now the share of the department using that product, shaded on one grey
 * scale, and the Active column is the share of the department active in the last 7 days.
 * Only a department below the admin-set target is coloured (amber): there is no other
 * green, amber or red.
 */
import type { CSSProperties } from 'react';
import { Panel, Muted, T, Tag } from '@/components/precision/ui';
import { PRODUCT_COLOR, SHARE_BAR } from '@/lib/ui/chart-colours';
import type { Product, ProductCounts } from '@/lib/dashboard/vendor';

interface DeptStats {
  department: string;
  user_count: number;
  active_users: number;
  /** People who used each product in the last 7 days. */
  products: ProductCounts;
}

/** One grey scale: darker only ever means a larger share of the department. */
function shade(share: number): CSSProperties {
  if (share <= 0) return { background: '#FAFAFA', color: '#B3B3B3' };
  if (share >= 0.6) return { background: SHARE_BAR, color: '#FFFFFF' };
  if (share >= 0.35) return { background: `${SHARE_BAR}99`, color: '#FFFFFF' };
  if (share >= 0.15) return { background: `${SHARE_BAR}40`, color: '#0A0A0A' };
  return { background: `${SHARE_BAR}1A`, color: '#4D4D4D' };
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export default function DepartmentHeatmap({ data: all, products, targetPct }: { data: DeptStats[]; products: readonly Product[]; targetPct: number | null }) {
  const rows = all
    .filter(d => d.user_count > 0)
    .map(d => ({ ...d, active: d.active_users / d.user_count }))
    .sort((a, b) => b.active - a.active);
  if (rows.length === 0) {
    return (
      <Panel title="Which departments are using it?">
        <div className="py-6 text-center"><Muted>No department data yet. Set people&apos;s departments on the User Insights page.</Muted></div>
      </Panel>
    );
  }
  const target = targetPct !== null ? targetPct / 100 : null;
  const below = target === null ? [] : rows.filter(r => r.active < target);
  const top = rows[0];
  const answer = target === null
    ? <><b className="font-semibold">{top.department}</b> uses it most: {Math.round(top.active * 100)}% of the department in the last 7 days.</>
    : below.length === 0
      ? <>Every department is at or above your <b className="font-semibold">{targetPct}%</b> target. {top.department} leads at {Math.round(top.active * 100)}%.</>
      : below.length <= 3
        ? <><b className="font-semibold">{list(below.map(b => b.department))}</b> {below.length === 1 ? 'is' : 'are'} below your {targetPct}% target. {top.department} leads at {Math.round(top.active * 100)}%.</>
        : <><b className="font-semibold">{below.length} of {rows.length}</b> departments are below your {targetPct}% target. {top.department} leads at {Math.round(top.active * 100)}%.</>;

  return (
    <Panel
      title="Which departments are using it?"
      badge={<Tag tone="measured">Measured</Tag>}
      right={<span className="text-[13px] text-[#8F8F8F]">Last 7 days</span>}
      className="h-full"
      flush
    >
      <p className="m-0 px-4 pt-3 pb-2 text-[15px] leading-6 text-[#0A0A0A]">{answer}</p>
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Department</th>
              {products.map(p => (
                <th key={p.id} scope="col" className={`${T.th} text-center`}>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PRODUCT_COLOR[p.id] }} />{p.label}
                  </span>
                </th>
              ))}
              <th scope="col" className={`${T.th} text-center`}>Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(d => {
              const isBelow = target !== null && d.active < target;
              return (
                <tr key={d.department} className={T.row}>
                  <td className={`${T.td} font-medium text-[#0A0A0A]`}>
                    {d.department}
                    <span className="block text-[12px] font-normal text-[#8F8F8F]">{d.active_users} of {d.user_count} people</span>
                  </td>
                  {products.map(p => {
                    const share = d.products[p.id] / d.user_count;
                    return (
                      <td key={p.id} className="px-1 py-1.5">
                        <div className="rounded-[6px] text-center py-1 text-[13px] font-medium tabular-nums" style={shade(share)} title={`${d.products[p.id]} of ${d.user_count} people`}>
                          {Math.round(share * 100)}%
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-1 py-1.5">
                    <div
                      className="rounded-[6px] text-center py-1 text-[13px] font-semibold tabular-nums"
                      style={isBelow ? { background: '#FFF1E0', color: '#B54708', border: '1px solid #F5D9A8' } : { background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #EAEAEA' }}
                    >
                      {Math.round(d.active * 100)}%
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2.5 border-t border-[#F2F2F2] text-[12px] text-[#8F8F8F] flex flex-wrap gap-x-4 gap-y-1 items-center">
        <span>Cells show the share of the department using each product; darker means more.</span>
        {target !== null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: '#FFF1E0', border: '1px solid #F5D9A8' }} />Below your {targetPct}% target, set in Admin → System
          </span>
        )}
      </div>
    </Panel>
  );
}

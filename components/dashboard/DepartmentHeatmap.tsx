// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { CSSProperties } from 'react';
import { Panel, Muted, T, Bar, Tag } from '@/components/precision/ui';
import { PRODUCT_COLOR, PRODUCT_INK } from '@/lib/ui/chart-colours';
import { sumShown, type Product, type ProductCounts, type ProductId } from '@/lib/dashboard/vendor';

interface DeptStats {
  department: string;
  user_count: number;
  active_users: number;
  /** People who used each product in the last 7 days. */
  products: ProductCounts;
}

// Each product column is shaded in its own colour, light to full, so the products
// can be told apart at a glance. Hex alpha suffixes: 1A = 10%, 40 = 25%, 99 = 60%.
function intensity(value: number, max: number, product: ProductId): CSSProperties {
  if (max === 0 || value === 0) return { background: '#FAFAFA', color: '#B3B3B3' };
  const pct = value / max;
  const hex = PRODUCT_COLOR[product];
  if (pct > 0.7) return { background: hex, color: PRODUCT_INK[product] };
  if (pct > 0.4) return { background: `${hex}99`, color: product === 'claude_cowork' ? '#FFFFFF' : '#05073F' };
  if (pct > 0.15) return { background: `${hex}40`, color: '#0A0A0A' };
  return { background: `${hex}1A`, color: '#4D4D4D' };
}

function Legend() {
  return (
    <span className="flex items-center gap-3 text-[13px] text-[#8F8F8F]">
      <span>Lighter = less, darker = more</span>
    </span>
  );
}

function ProductHead({ product }: { product: Product }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PRODUCT_COLOR[product.id] }} />
      {product.label}
    </span>
  );
}

/** One column per product shown: the chosen vendor's three, or all six. */
export default function DepartmentHeatmap({ data: all, products }: { data: DeptStats[]; products: readonly Product[] }) {
  // Busiest departments first, by people across the products shown.
  const data = [...all].sort((a, b) => sumShown(b.products, products) - sumShown(a.products, products));
  if (data.length === 0) {
    return (
      <Panel title="Department adoption">
        <div className="py-6 text-center"><Muted>No department data available.</Muted></div>
      </Panel>
    );
  }

  const max = Object.fromEntries(products.map(p => [p.id, Math.max(...data.map(d => d.products[p.id]), 1)])) as Record<ProductId, number>;
  const colWidth = products.length > 3 ? 'w-[10%]' : 'w-[14%]';

  const cell = (value: number, product: ProductId) => (
    <div className="rounded-[6px] text-center py-1 text-[13px] font-medium tabular-nums" style={intensity(value, max[product], product)}>
      {value > 0 ? value.toLocaleString() : '–'}
    </div>
  );

  return (
    <Panel
      title="Department adoption heatmap"
      badge={<Tag tone="measured">Measured</Tag>}
      right={<Legend />}
      className="h-full"
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Department</th>
              <th scope="col" className={T.thRight}>Users</th>
              {products.map(p => (
                <th key={p.id} scope="col" className={`${T.th} text-center ${colWidth}`}><ProductHead product={p} /></th>
              ))}
              <th scope="col" className={`${T.th} w-[22%]`}>Adoption</th>
            </tr>
          </thead>
          <tbody>
            {data.map(dept => {
              const adoptionPct = dept.user_count > 0
                ? Math.round((dept.active_users / dept.user_count) * 100)
                : 0;
              const tone = adoptionPct >= 70 ? 'good' : adoptionPct >= 40 ? 'warn' : 'bad';

              return (
                <tr key={dept.department} className={T.row}>
                  <td className={`${T.td} font-medium text-[#0A0A0A]`}>{dept.department}</td>
                  <td className={`${T.tdRight} text-[#666666]`}>{dept.active_users}/{dept.user_count}</td>
                  {products.map(p => (
                    <td key={p.id} className="px-1 py-1.5">{cell(dept.products[p.id], p.id)}</td>
                  ))}
                  <td className={T.td}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1"><Bar pct={adoptionPct} tone={tone} height={6} /></div>
                      <span className="text-[13px] text-[#666666] w-9 text-right tabular-nums">{adoptionPct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

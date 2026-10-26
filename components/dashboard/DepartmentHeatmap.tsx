// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { CSSProperties } from 'react';
import { Panel, Muted, T, Bar, Tag } from '@/components/precision/ui';
import { SURFACE_COLOR, SURFACE_INK } from '@/lib/ui/chart-colours';

type Surface = keyof typeof SURFACE_COLOR;

interface DeptStats {
  department: string;
  user_count: number;
  active_users: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

// Each surface column is shaded in its own colour, light to full, so Chat, Code and
// Cowork can be told apart at a glance. Hex alpha suffixes: 1A = 10%, 40 = 25%, 99 = 60%.
function intensity(value: number, max: number, surface: Surface): CSSProperties {
  if (max === 0 || value === 0) return { background: '#FAFAFA', color: '#B3B3B3' };
  const pct = value / max;
  const hex = SURFACE_COLOR[surface];
  if (pct > 0.7) return { background: hex, color: SURFACE_INK[surface] };
  if (pct > 0.4) return { background: `${hex}99`, color: surface === 'cowork' ? '#FFFFFF' : '#05073F' };
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

function SurfaceHead({ surface, label }: { surface: Surface; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR[surface] }} />
      {label}
    </span>
  );
}

export default function DepartmentHeatmap({ data }: { data: DeptStats[] }) {
  if (data.length === 0) {
    return (
      <Panel title="Department adoption">
        <div className="py-6 text-center"><Muted>No department data available.</Muted></div>
      </Panel>
    );
  }

  const maxChat = Math.max(...data.map(d => d.surface_chat), 1);
  const maxCode = Math.max(...data.map(d => d.surface_code), 1);
  const maxCowork = Math.max(...data.map(d => d.surface_cowork), 1);

  const cell = (value: number, max: number, surface: Surface) => (
    <div className="rounded-[6px] text-center py-1 text-[13px] font-medium tabular-nums" style={intensity(value, max, surface)}>
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
              <th scope="col" className={`${T.th} text-center w-[14%]`}><SurfaceHead surface="chat" label="Chat" /></th>
              <th scope="col" className={`${T.th} text-center w-[14%]`}><SurfaceHead surface="code" label="Code" /></th>
              <th scope="col" className={`${T.th} text-center w-[14%]`}><SurfaceHead surface="cowork" label="Cowork" /></th>
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
                  <td className="px-1 py-1.5">{cell(dept.surface_chat, maxChat, 'chat')}</td>
                  <td className="px-1 py-1.5">{cell(dept.surface_code, maxCode, 'code')}</td>
                  <td className="px-1 py-1.5">{cell(dept.surface_cowork, maxCowork, 'cowork')}</td>
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

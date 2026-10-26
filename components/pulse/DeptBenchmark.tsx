// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DeptRow } from '@/components/pulse/DeptTable';
import { buildDeptBenchmark } from '@/lib/pulse/dept-benchmark';
import { Panel, PanelFoot, Pill } from '@/components/precision/ui';

interface DeptBenchmarkProps {
  depts: DeptRow[];
}

export default function DeptBenchmark({ depts }: DeptBenchmarkProps) {
  const [floor, setFloor] = useState(1.5);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => { const f = parseFloat(String(c.ddsSupportFloor)); if (!isNaN(f)) setFloor(f); })
      .catch(() => {});
  }, []);

  const bench = useMemo(
    () => buildDeptBenchmark(depts.map(d => ({ department: d.department, member_count: d.member_count, avg_dds: d.avg_dds })), { floor }),
    [depts, floor],
  );

  // Hidden until at least two departments are comparable (a spread needs a median).
  const comparable = bench.rows.filter(r => !r.tooSmall && r.deltaFromMedian !== null);
  if (bench.median === null || comparable.length < 2) return null;

  const maxAbs = Math.max(0.01, ...comparable.map(r => Math.abs(r.deltaFromMedian as number)));
  const flaggedCount = bench.rows.filter(r => r.needsSupport).length;

  return (
    <Panel title="Department benchmark" subtitle={`Delegation depth around the organisation median (${bench.median.toFixed(2)})`} flush>
      <p className="m-0 px-4 pt-3 text-[13px] text-[#666666] leading-5">
        Is adoption even, or lumpy? Departments below the support floor (delegation depth under {floor.toFixed(2)}) are flagged
        for support. They are not ranked, and not flagged for sitting below the median.
      </p>
      <div className="px-4 py-3 flex flex-col gap-2">
        {bench.rows.map(r => {
          if (r.tooSmall) {
            return (
              <div key={r.department} className="flex items-center gap-3 text-[14px] text-[#8F8F8F]">
                <span className="w-28 shrink-0 truncate">{r.department}</span>
                <span className="text-[13px]">too small to compare ({r.memberCount})</span>
              </div>
            );
          }
          if (r.deltaFromMedian === null) {
            return (
              <div key={r.department} className="flex items-center gap-3 text-[14px] text-[#8F8F8F]">
                <span className="w-28 shrink-0 truncate">{r.department}</span>
                <span className="text-[13px]">no delegation data yet</span>
              </div>
            );
          }
          const delta = r.deltaFromMedian;
          const pct = (Math.abs(delta) / maxAbs) * 50; // half-track each side
          const below = delta < 0;
          return (
            <div key={r.department} className="flex items-center gap-3 text-[14px]">
              <span className="w-28 shrink-0 truncate text-[#0A0A0A]">{r.department}</span>
              <div className="flex-1 relative h-4">
                {/* median centre line */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#DADADA]" />
                <div
                  className={`absolute top-1 bottom-1 rounded-full ${r.needsSupport ? 'bg-[#DC8A00]' : below ? 'bg-[#DADADA]' : 'bg-[#05073F]'}`}
                  style={below ? { right: '50%', width: `${pct}%` } : { left: '50%', width: `${pct}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-[#666666] tabular-nums">{(r.avgDds as number).toFixed(2)}</span>
              {r.needsSupport && <Pill tone="warn">needs support</Pill>}
            </div>
          );
        })}
      </div>
      <PanelFoot>
        {flaggedCount === 0
          ? 'No department is below the support floor: adoption depth is holding across the organisation.'
          : `${flaggedCount} department${flaggedCount === 1 ? '' : 's'} below the support floor. Support action, not a league position.`}
      </PanelFoot>
    </Panel>
  );
}

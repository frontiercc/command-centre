// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { Panel, T, Muted } from '@/components/precision/ui';

export interface DeptRow {
  department: string;
  member_count: number;
  avg_dds: number | null;
  avg_oti: number | null;
  avg_ors: number | null;
}

interface DeptTableProps {
  depts: DeptRow[];
}

function fmt(val: number | null, decimals = 2): string {
  if (val === null) return '—';
  return val.toFixed(decimals);
}

function ResilienceCell({ ors }: { ors: number | null }) {
  if (ors === null) return <span className="text-[#8F8F8F]">—</span>;
  const low = ors < 0.7;
  return (
    <span
      className={low ? 'font-medium text-[#B54708]' : 'text-[#0A0A0A]'}
      title={low ? 'Concentration risk: resilience below 0.70' : undefined}
    >
      {ors.toFixed(2)}{low && <><span aria-hidden="true"> ⚠️</span><span className="sr-only"> (concentration risk)</span></>}
    </span>
  );
}

export default function DeptTable({ depts }: DeptTableProps) {
  if (depts.length === 0) {
    return (
      <Panel title="Departments">
        <Muted>No departments found. Set department values on users to see the breakdown here.</Muted>
      </Panel>
    );
  }

  return (
    <Panel title="Departments" subtitle={`${depts.length} department${depts.length === 1 ? '' : 's'}`} flush>
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Department</th>
              <th scope="col" className={T.thRight}>Members</th>
              <th scope="col" className={T.thRight} title="Average delegation depth score">Delegation depth</th>
              <th scope="col" className={T.thRight} title="Average output against baseline">More valuable work</th>
              <th scope="col" className={T.thRight} title="Operational resilience score; amber below 0.70">Resilience</th>
              <th scope="col" className={T.th}><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {depts.map(d => (
              <tr key={d.department} className={T.row}>
                <td className={`${T.td} font-medium text-[#0A0A0A]`}>{d.department}</td>
                <td className={`${T.tdRight} text-[#666666]`}>{d.member_count}</td>
                <td className={T.tdRight}>{fmt(d.avg_dds)}</td>
                <td className={T.tdRight}>{d.avg_oti !== null ? `${fmt(d.avg_oti)}×` : '—'}</td>
                <td className={T.tdRight}><ResilienceCell ors={d.avg_ors} /></td>
                <td className={`${T.td} text-right`}>
                  <Link
                    href={`/pulse/dept?dept=${encodeURIComponent(d.department)}`}
                    className="text-[13px] font-medium text-[#245BF3] hover:underline"
                    aria-label={`View ${d.department} department pulse`}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

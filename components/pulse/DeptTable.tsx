// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { Panel, T, Muted } from '@/components/precision/ui';

export interface DeptRow {
  department: string;
  member_count: number;
  /** The share of the department's judged tasks that were meaningful or frontier. Null when none were judged. */
  deep_share: number | null;
  tasks: number;
}

interface DeptTableProps {
  depts: DeptRow[];
}

/** Each department described by its work, never by a score. */
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
              <th scope="col" className={T.thRight}>Tasks judged</th>
              <th scope="col" className={T.thRight} title="The share of the department's judged tasks that were meaningful or frontier">Meaningful or frontier</th>
              <th scope="col" className={T.th}><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {depts.map(d => (
              <tr key={d.department} className={T.row}>
                <td className={`${T.td} font-medium text-[#0A0A0A]`}>{d.department}</td>
                <td className={`${T.tdRight} text-[#666666]`}>{d.member_count}</td>
                <td className={`${T.tdRight} text-[#666666] tabular-nums`}>{d.tasks.toLocaleString('en-GB')}</td>
                <td className={`${T.tdRight} tabular-nums`}>{d.deep_share === null ? 'Not judged' : `${Math.round(d.deep_share * 100)}%`}</td>
                <td className={`${T.td} text-right`}>
                  <Link
                    href={`/pulse/dept?dept=${encodeURIComponent(d.department)}`}
                    className="text-[13px] font-medium text-[#1F6F8B] hover:underline"
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

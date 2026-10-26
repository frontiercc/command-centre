// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Panel, Muted, T } from '@/components/precision/ui';

export interface MemberRow {
  id: string;
  display_name: string | null;
  email: string;
  dds: number | null;
  oti: number | null;
  last_active: number | null;
}

interface MemberTableProps {
  members: MemberRow[];
}

function fmt(val: number | null, decimals = 2): string {
  if (val === null) return '—';
  return val.toFixed(decimals);
}

function timeAgo(ts: number | null): string {
  if (!ts) return '—';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 3600) return 'just now';
  const hours = Math.floor(secs / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function MemberTable({ members }: MemberTableProps) {
  // Open goes to /pulse/user/<id>, which is admin-only: anyone else clicking it
  // was sent away (to the Audit Log, then back to their own page). Only admins
  // get the button; it stays hidden until the role is known.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => setIsAdmin(d?.authenticated === true && d.user?.role === 'admin'))
      .catch(() => {});
  }, []);

  if (members.length === 0) {
    return (
      <Panel title="Team members">
        <Muted>No members found in this department.</Muted>
      </Panel>
    );
  }

  return (
    <Panel
      title="Team members"
      subtitle={`${members.length} ${members.length === 1 ? 'person' : 'people'}`}
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Name</th>
              <th scope="col" className={T.thRight} title="Weighted average tier, AI-judged">Delegation depth</th>
              <th scope="col" className={T.thRight} title="Output now against their own start">More valuable work</th>
              <th scope="col" className={T.thRight}>Last active</th>
              {isAdmin && <th scope="col" className={T.th}><span className="sr-only">Open</span></th>}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className={T.row}>
                <td className={`${T.td} font-medium text-[#0A0A0A]`}>
                  {m.display_name ?? m.email}
                </td>
                <td className={T.tdRight}>{fmt(m.dds)}</td>
                <td className={T.tdRight}>
                  {m.oti !== null ? `${fmt(m.oti)}×` : '—'}
                </td>
                <td className={`${T.tdRight} text-[13px] text-[#8F8F8F]`}>{timeAgo(m.last_active)}</td>
                {isAdmin && (
                  <td className={`${T.td} text-right`}>
                    <Link
                      href={`/pulse/user/${encodeURIComponent(m.id)}`}
                      className="text-[13px] font-medium text-[#245BF3] hover:underline"
                      aria-label={`View ${m.display_name ?? m.email} pulse`}
                    >
                      Open
                    </Link>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

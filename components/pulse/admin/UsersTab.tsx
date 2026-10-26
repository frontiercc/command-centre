// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { Panel, Muted, Tag, B, T, cx } from '@/components/precision/ui';

interface UserRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  dds: number | null;
  oti: number | null;
  ors: number | null;
  psr: number | null;
  tier_1_count: number | null;
  tier_2_count: number | null;
  tier_3_count: number | null;
  last_briefing_at: number | null;
  last_active_at: number | null;
  pending_count: number;
  failed_count: number;
}

type SortKey = 'name' | 'dept' | 'dds' | 'oti' | 'last_active';

function timeAgo(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function TierBar({ t1, t2, t3 }: { t1: number; t2: number; t3: number }) {
  const total = t1 + t2 + t3;
  if (total === 0) return <span className="text-[13px] text-[#B3B3B3]">—</span>;
  // Tiers are AI-judged: sky blue steps, light to dark from Tier 1 to Tier 3.
  return (
    <div className="flex h-2 w-20 rounded-full overflow-hidden gap-px bg-[#F2F2F2]" title={`T1:${t1} T2:${t2} T3:${t3}`}>
      {t1 > 0 && <div className="bg-[#CCD1DB]" style={{ width: `${(t1 / total) * 100}%` }} />}
      {t2 > 0 && <div className="bg-[#8DB2FC]" style={{ width: `${(t2 / total) * 100}%` }} />}
      {t3 > 0 && <div className="bg-[#3D6CE8]" style={{ width: `${(t3 / total) * 100}%` }} />}
    </div>
  );
}

function sortUsers(users: UserRow[], key: SortKey, asc: boolean): UserRow[] {
  return [...users].sort((a, b) => {
    let va: string | number, vb: string | number;
    switch (key) {
      case 'name': va = (a.display_name ?? a.email).toLowerCase(); vb = (b.display_name ?? b.email).toLowerCase(); break;
      case 'dept': va = (a.department ?? '').toLowerCase(); vb = (b.department ?? '').toLowerCase(); break;
      case 'dds': va = a.dds ?? -1; vb = b.dds ?? -1; break;
      case 'oti': va = a.oti ?? -1; vb = b.oti ?? -1; break;
      case 'last_active': va = a.last_active_at ?? 0; vb = b.last_active_at ?? 0; break;
      default: return 0;
    }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });
}

export default function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('dds');
  const [sortAsc, setSortAsc] = useState(false);
  const [search, setSearch] = useState('');

  // Drill down goes to /admin/pulse/users/<id>, which is admin-only: a manager
  // clicking it was sent to the Audit Log. Only admins get the link; it stays
  // hidden until the role is known.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => setIsAdmin(d?.authenticated === true && d.user?.role === 'admin'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/pulse/admin/users')
      .then(r => r.json())
      .then(d => setUsers(d.users ?? []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    return !q ||
      (u.display_name ?? '').toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.department ?? '').toLowerCase().includes(q);
  });

  const sorted = sortUsers(filtered, sortKey, sortAsc);

  const SortHdr = ({ k, label, right = false }: { k: SortKey; label: string; right?: boolean }) => (
    <th
      scope="col"
      aria-sort={sortKey === k ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      className={cx(right ? T.thRight : T.th, sortKey === k && 'text-[#0A0A0A]')}
    >
      <button type="button" onClick={() => handleSort(k)} className="font-medium hover:text-[#0A0A0A] select-none">
        {label}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  if (loading) return (
    <Panel>
      <Muted>Loading users…</Muted>
    </Panel>
  );

  return (
    <Panel
      title="Users"
      subtitle={`${sorted.length} users`}
      right={
        <input
          type="text"
          placeholder="Search name, email, or department…"
          aria-label="Search users"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={cx(B.input, 'w-full sm:w-72')}
        />
      }
      badge={<Tag tone="judged">AI-judged tiers</Tag>}
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <SortHdr k="name" label="Name" />
              <SortHdr k="dept" label="Department" />
              <SortHdr k="dds" label="Depth" right />
              <SortHdr k="oti" label="Valuable work" right />
              <th scope="col" className={T.th}>Tier mix</th>
              <SortHdr k="last_active" label="Last active" />
              <th scope="col" className={T.th}>Briefing</th>
              <th scope="col" className={T.th}>Queue</th>
              {isAdmin && <th scope="col" className={T.th}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map(u => (
              <tr key={u.id} className={T.row}>
                <td className={T.td}>
                  <div className="min-w-0">
                    <p className="m-0 font-medium text-[#0A0A0A]">{u.display_name ?? u.email}</p>
                    {u.display_name && <p className="m-0 text-[13px] text-[#8F8F8F]">{u.email}</p>}
                  </div>
                </td>
                <td className={T.tdMute}>{u.department ?? '—'}</td>
                <td className={cx(T.tdRight, 'font-medium')}>
                  {u.dds != null ? u.dds.toFixed(2) : '—'}
                </td>
                <td className={T.tdRight}>
                  {u.oti != null ? `${u.oti.toFixed(2)}×` : '—'}
                </td>
                <td className={T.td}>
                  <TierBar
                    t1={u.tier_1_count ?? 0}
                    t2={u.tier_2_count ?? 0}
                    t3={u.tier_3_count ?? 0}
                  />
                </td>
                <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{timeAgo(u.last_active_at)}</td>
                <td className={T.td}>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                      {u.last_briefing_at ? timeAgo(u.last_briefing_at) : 'Never'}
                    </span>
                    <GenerateBriefingButton
                      type="user"
                      userId={u.id}
                      label="Regenerate"
                      onComplete={() => {}}
                    />
                  </div>
                </td>
                <td className={T.td}>
                  <div className="flex items-center gap-1 flex-wrap">
                    {u.pending_count > 0 && (
                      <Tag tone="warn" title="Pending classification">{u.pending_count} pending</Tag>
                    )}
                    {u.failed_count > 0 && (
                      <Tag tone="bad" title="Failed classification">{u.failed_count} failed</Tag>
                    )}
                  </div>
                </td>
                {isAdmin && (
                  <td className={cx(T.td, 'whitespace-nowrap')}>
                    <Link
                      href={`/admin/pulse/users/${encodeURIComponent(u.id)}`}
                      className={B.link}
                    >
                      Drill down →
                    </Link>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="px-4 py-8 text-center">
            <Muted>{search ? 'No users match your search.' : 'No users with Pulse data yet.'}</Muted>
          </div>
        )}
      </div>
    </Panel>
  );
}

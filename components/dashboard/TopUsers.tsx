// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { Panel, PanelFoot, Muted } from '@/components/precision/ui';
import { SURFACE_COLOR } from '@/components/dashboard/AdoptionChart';

interface TopUser {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  total_activity: number;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

export default function TopUsers({ users }: { users: TopUser[] }) {
  if (users.length === 0) {
    return (
      <Panel title="Top users this week">
        <div className="py-6 text-center"><Muted>No activity data yet.</Muted></div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Top users this week"
      right={<Link href="/users" className="text-[13px] font-medium text-[#245BF3] hover:underline">View all</Link>}
      className="h-full"
      flush
    >
      <ul className="m-0 p-0 list-none">
        {users.map((user, i) => {
          const total = user.surface_chat + user.surface_code + user.surface_cowork;
          const chatPct = total > 0 ? (user.surface_chat / total) * 100 : 0;
          const codePct = total > 0 ? (user.surface_code / total) * 100 : 0;
          const coworkPct = total > 0 ? (user.surface_cowork / total) * 100 : 0;

          return (
            <li key={user.id} className="px-4 py-2.5 flex items-center gap-3 border-t border-[#F2F2F2] first:border-t-0">
              <span className="text-[12px] text-[#B3B3B3] w-4 shrink-0 tabular-nums">{i + 1}</span>

              <div className="flex-1 min-w-0">
                <Link href={`/users/${user.id}`} className="text-[14px] font-medium text-[#0A0A0A] hover:underline truncate block">
                  {user.display_name || user.email}
                </Link>
                {user.department && <p className="m-0 text-[13px] text-[#8F8F8F] truncate">{user.department}</p>}
              </div>

              {/* Surface split */}
              <div className="w-20 shrink-0">
                <div className="flex h-1.5 rounded-full overflow-hidden bg-[#F2F2F2] gap-px">
                  {chatPct > 0 && <div style={{ width: `${chatPct}%`, background: SURFACE_COLOR.chat }} />}
                  {codePct > 0 && <div style={{ width: `${codePct}%`, background: SURFACE_COLOR.code }} />}
                  {coworkPct > 0 && <div style={{ width: `${coworkPct}%`, background: SURFACE_COLOR.cowork }} />}
                </div>
              </div>

              <span className="w-14 text-right text-[14px] font-semibold tabular-nums text-[#0A0A0A]">
                {user.total_activity.toLocaleString()}
              </span>
            </li>
          );
        })}
      </ul>

      <PanelFoot>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR.chat }} /> Chat</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR.code }} /> Code</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR.cowork }} /> Cowork</span>
        </span>
      </PanelFoot>
    </Panel>
  );
}

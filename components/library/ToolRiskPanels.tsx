// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Two cards on the S&C Board, moved from Work Pulse's former Tool Usage page: skills and
// connectors only one person uses (if they left, that work stops), and claimed entries nobody has
// used in 30 days (worth retiring, or a nudge). Read from /api/pulse/skills-overview, as before.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Frame, Track } from '@/components/pulse/WorkPulseOverview';
import { Muted, LOAD_FAILED } from '@/components/precision/ui';

export interface SoleRow { kind: 'skill' | 'connector'; name: string; tag: string; uses: number; who: string | null; department: string | null }
export interface UnusedRow { id: number; name: string; kind: string; author: string | null; claimed: boolean; lastUsed: number | null }

const kindWord = (k: string) => (k === 'connector' ? 'connector' : 'skill');
const num = (n: number) => n.toLocaleString('en-GB');

/** One sentence: how many claimed entries went unused this month, and how many were never used. */
function unusedSentence(n: number, of: number, never: number): string {
  const who = of === 1 ? 'The one claimed skill or connector'
    : n === of ? `All ${num(of)} claimed skills and connectors`
    : `${num(n)} of ${num(of)} claimed skills and connectors`;
  if (never === n) return `${who} ${n === 1 ? 'has' : 'have'} never been used.`;
  return `${who} went unused this month${never > 0 ? `, ${num(never)} of them never used` : ''}.`;
}
const dateOf = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function Stuck({ rows }: { rows: SoleRow[] }) {
  return (
    <Frame
      title="Stuck with one person"
      period="Last 30 days"
      answer={rows.length === 0
        ? <>Nobody this month.</>
        : <><b>{rows.length === 1 ? 'One skill or connector is' : `${rows.length} skills and connectors are`}</b> used by one person only. If they left, that work stops.</>}
      note={rows.length > 0 ? 'Pairing someone with them is the fix.' : undefined}
    >
      {rows.map(r => (
        <div key={`${r.kind}:${r.name}`} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <span className="min-w-0 truncate text-[#0A0A0A]">{r.name}</span>
          <span className="text-[#777777] whitespace-nowrap">{kindWord(r.kind)} · only {r.who ?? 'one person'}{r.department ? ` · ${r.department}` : ''}</span>
          <span className="ml-auto tabular-nums text-[#333333] whitespace-nowrap">{num(r.uses)} {r.uses === 1 ? 'use' : 'uses'}</span>
        </div>
      ))}
    </Frame>
  );
}

function Unused({ rows, of }: { rows: UnusedRow[]; of: number }) {
  if (of === 0) return (
    <Frame title="Used by nobody" period="Last 30 days">
      <Muted>Nobody has claimed a skill or connector yet, so there is nothing to check.</Muted>
    </Frame>
  );
  const never = rows.filter(r => r.lastUsed === null).length;
  return (
    <Frame
      title="Used by nobody"
      period="Last 30 days"
      answer={rows.length === 0
        ? <>Every one of the {num(of)} claimed skills and connectors was used this month.</>
        : <>{unusedSentence(rows.length, of, never)}</>}
    >
      {rows.length > 0 && <div className="mb-2"><Track value={rows.length / of} /></div>}
      {rows.slice(0, 10).map(r => (
        <div key={r.id} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <Link href={`/library/${r.id}`} className="min-w-0 truncate text-[#0A0A0A] hover:text-[#1F6F8B]">{r.name}</Link>
          <span className="text-[#777777] whitespace-nowrap">{kindWord(r.kind)}{r.author ? ` · ${r.author}` : ''}</span>
          <span className="ml-auto whitespace-nowrap" style={{ color: '#8F8F8F' }}>
            {r.lastUsed === null ? 'never used' : `last used ${dateOf(r.lastUsed)}`}
          </span>
        </div>
      ))}
      {rows.length > 10 && <p className="m-0 mt-1.5 text-[13px] text-[#8F8F8F]">and {num(rows.length - 10)} more.</p>}
    </Frame>
  );
}

/** Both cards, one above the other in the board's right column. Loading or failed, each card keeps its place and says which. */
export default function ToolRiskPanels() {
  const [data, setData] = useState<{ sole: SoleRow[]; unused: UnusedRow[]; unusedOf: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/pulse/skills-overview')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(d => setData({ sole: d.sole ?? [], unused: d.unused ?? [], unusedOf: d.unusedOf ?? 0 }))
      .catch(() => setFailed(true));
  }, []);
  if (!data) return (
    <div className="flex flex-col gap-4 min-w-0">
      {['Stuck with one person', 'Used by nobody'].map(t => (
        <Frame key={t} title={t} period="Last 30 days"><Muted>{failed ? LOAD_FAILED : 'Loading…'}</Muted></Frame>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Stuck rows={data.sole} />
      <Unused rows={data.unused} of={data.unusedOf} />
    </div>
  );
}

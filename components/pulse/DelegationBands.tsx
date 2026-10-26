// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Delegation over time: stacked tier bands per week + then-vs-now rows.
// Serves BOTH levels of the delegation view with the same visual grammar:
// the dept page (dept bands + people rows) and the CIO overview (org-wide
// bands + department rows), replacing the CIO line chart.
// Weeks with no data render as gaps; charts split at rubric changes.
'use client';

import { MIN_CHART_DATA_WEEKS } from '@/lib/pulse/delegation';
import { Panel, PanelFoot, Segmented, SubHead, Spark } from '@/components/precision/ui';

interface BandWeek { weekStart: number; t1Share: number | null; t2Share: number | null; t3Share: number | null }
export interface BandSegment { weeks: BandWeek[]; startsAtRubricBreak: boolean }
export interface PersonDelegation {
  userId: string;
  displayName: string;
  sparkline: Array<number | null>;
  thenVsNow: { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down'; dataWeeks: number } | null;
  dataWeeks: number;
}

const H = 170;
const ARROW_COLOR = { up: '#1A7F37', flat: '#8F8F8F', down: '#B54708' } as const;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const shortDate = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function DelegationBands({
  bands, bandsDataWeeks, people, window: win, onWindowChange,
  title = 'Delegation over time',
  subtitle = 'Weekly tier mix, AI-judged',
  rowsHeading = 'People, then vs now',
  buildingNote,
}: {
  bands: BandSegment[];
  bandsDataWeeks: number;
  people: PersonDelegation[];
  window: 13 | 26 | 52;
  onWindowChange: (w: 13 | 26 | 52) => void;
  title?: string;
  subtitle?: string;
  rowsHeading?: string;
  buildingNote?: string;
}) {
  const hasChart = bandsDataWeeks >= MIN_CHART_DATA_WEEKS;
  const allWeeks = bands.flatMap(s => s.weeks);
  const ticks = allWeeks.length > 0
    ? [allWeeks[0], allWeeks[Math.floor(allWeeks.length / 3)], allWeeks[Math.floor((allWeeks.length * 2) / 3)], allWeeks[allWeeks.length - 1]]
    : [];

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      flush
      right={
        <Segmented
          label="Window"
          value={win}
          onChange={onWindowChange}
          options={[{ value: 13, label: '13w' }, { value: 26, label: '26w' }, { value: 52, label: '52w' }]}
        />
      }
    >
      <div className={`p-4 grid gap-6 ${people.length > 0 ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : ''}`}>
        <div className="min-w-0 flex flex-col gap-2">
          {hasChart ? (
            <>
              <div className="flex items-end gap-[3px] border-b border-[#EAEAEA]" style={{ height: H }} role="img" aria-label="Weekly tier mix bands">
                {bands.map((seg, si) => (
                  <div key={si} className={`flex items-end gap-[3px] h-full flex-1 ${seg.startsAtRubricBreak ? 'border-l border-dashed border-[#B3B3B3] pl-1' : ''}`}>
                    {seg.weeks.map(w => w.t1Share === null ? (
                      <div key={w.weekStart} className="flex-1 h-1 rounded-full bg-[#F2F2F2] self-end" title="no data" />
                    ) : (
                      <div key={w.weekStart} className="flex-1 h-full flex flex-col justify-end gap-px" title={shortDate(w.weekStart)}>
                        <div className="bg-[#3D6CE8] rounded-t-[2px]" style={{ height: `${(w.t3Share ?? 0) * 100}%` }} />
                        <div className="bg-[#8DB2FC]" style={{ height: `${(w.t2Share ?? 0) * 100}%` }} />
                        <div className="bg-[#CCD1DB]" style={{ height: `${(w.t1Share ?? 0) * 100}%` }} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {ticks.length > 0 && (
                <div className="flex justify-between text-[12px] text-[#8F8F8F] tabular-nums">
                  {ticks.map((t, i) => <span key={i}>{shortDate(t.weekStart)}</span>)}
                </div>
              )}
              <div className="flex gap-4 flex-wrap text-[13px] text-[#666666]">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2 rounded-full bg-[#CCD1DB] inline-block" />Tier 1, quick questions</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2 rounded-full bg-[#8DB2FC] inline-block" />Tier 2</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2 rounded-full bg-[#3D6CE8] inline-block" />Tier 3, delegated work</span>
              </div>
              {bands.some(s => s.startsAtRubricBreak) && (
                <p className="m-0 text-[13px] text-[#8F8F8F]">Dashed divider: the classifier rubric changed, so the mix either side is not comparable.</p>
              )}
            </>
          ) : (
            <p className="m-0 text-[13px] text-[#8F8F8F]">
              Building history: {bandsDataWeeks} week{bandsDataWeeks === 1 ? '' : 's'} of classified data so far; the chart appears at {MIN_CHART_DATA_WEEKS}.
            </p>
          )}
          {buildingNote && <p className="m-0 text-[13px] text-[#8F8F8F]">{buildingNote}</p>}
        </div>

        {people.length > 0 && (
          <div className="min-w-0 flex flex-col">
            <SubHead>{rowsHeading}</SubHead>
            <ul className="m-0 p-0 list-none">
              {people.map(p => (
                <li key={p.userId} className="py-2 border-t border-[#F2F2F2] flex items-center gap-2.5 text-[14px]">
                  <span className="w-28 truncate text-[#0A0A0A]" title={p.displayName}>{p.displayName}</span>
                  {p.thenVsNow ? (
                    <span className="flex items-center gap-1.5 tabular-nums">
                      <span className="text-[#666666]">{pct(p.thenVsNow.then)}</span>
                      <span style={{ color: ARROW_COLOR[p.thenVsNow.arrow] }} aria-label={`trend ${p.thenVsNow.arrow}`}>→</span>
                      <span className="font-semibold text-[#2451F3]">{pct(p.thenVsNow.now)}</span>
                    </span>
                  ) : (
                    <span className="text-[13px] text-[#8F8F8F]">
                      not enough history{p.dataWeeks > 0 ? ` (${p.dataWeeks}w)` : ''}
                    </span>
                  )}
                  {/* Depth is a bounded 0–1 share, so rows share one scale. */}
                  <span className="ml-auto" aria-label={`${p.displayName} weekly delegation depth`}>
                    <Spark data={p.sparkline} tone="judged" width={64} height={18} fixedMin={0} fixedMax={1} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <PanelFoot tone="judged">Tiers are AI-judged by a classifier, not measured. Then vs now is the share of classified work at Tier 2 or above; delegation depth, in the tables, is the average tier.</PanelFoot>
    </Panel>
  );
}

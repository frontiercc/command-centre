// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, PanelFoot, Tag } from '@/components/precision/ui';

interface GridCell {
  week: number;
  tier: number;
  count: number;
  /** How many of `count` are provisional (session still active — see code-pulse-otel-pivot-plan). */
  provisionalCount?: number;
}

interface JourneyGridProps {
  data: GridCell[];
  /** Set to true to show heatmap intensity instead of dots (team view) */
  heatmap?: boolean;
}

const WEEKS = [0, 1, 2, 3, 4, 5];
const TIERS = [3, 2, 1]; // Top = highest tier
const TIER_LABELS = { 3: 'Tier 3', 2: 'Tier 2', 1: 'Tier 1' };
const WEEK_LABELS = ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4', 'Wk 5', 'Wk 6'];

// Tiers are AI-judged, so the grid uses the judged (sky blue) scale.
const TIER_COLOURS = {
  3: 'bg-[#3D6CE8]',
  2: 'bg-[#8DB2FC]',
  1: 'bg-[#CCD1DB]',
};

const TIER_TEXT_COLOURS = {
  3: 'text-white',
  2: 'text-[#1F1466]',
  1: 'text-[#05073F]',
};

// Each step clearly darker than the last (lightness about 97 / 89 / 80 / 66 / 49).
const HEATMAP_COLOURS = [
  'bg-[#F7F7F7] text-[#0A0A0A]',
  'bg-[#D3E1FE] text-[#05073F]',
  'bg-[#A9C6FD] text-[#05073F]',
  'bg-[#6E9EFB] text-[#05073F]',
  'bg-[#3D6CE8] text-white',
];

function heatmapBg(count: number, max: number): string {
  if (count === 0 || max === 0) return HEATMAP_COLOURS[0];
  const idx = Math.min(4, Math.ceil((count / max) * 4));
  return HEATMAP_COLOURS[idx];
}

function cellTitle(count: number, provisionalCount: number): string {
  return `${count} event${count === 1 ? '' : 's'}${provisionalCount > 0 ? ` (${provisionalCount} provisional, session still active)` : ''}`;
}

function ProvisionalDot({ title }: { title: string }) {
  return (
    <span
      className="absolute -top-1 -right-1 w-2 h-2 rounded-full border border-white bg-[#DC8A00]"
      title={title}
    />
  );
}

export default function JourneyGrid({ data, heatmap = false }: JourneyGridProps) {
  // Build a lookup map
  const lookup = new Map<string, number>();
  const provisionalLookup = new Map<string, number>();
  let maxCount = 0;
  let hasProvisional = false;
  for (const cell of data) {
    const key = `${cell.week}-${cell.tier}`;
    lookup.set(key, cell.count);
    if (cell.provisionalCount) {
      provisionalLookup.set(key, cell.provisionalCount);
      hasProvisional = true;
    }
    if (cell.count > maxCount) maxCount = cell.count;
  }

  return (
    <Panel
      title={heatmap ? 'Team delegation journey' : 'Your delegation journey'}
      subtitle="6 weeks"
      right={<Tag tone="judged">AI-judged</Tag>}
      flush
    >
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full min-w-[400px] border-collapse">
          <thead>
            <tr className="text-[13px] text-[#8F8F8F]">
              <th scope="col" className="font-medium text-left pb-2 w-16">Tier</th>
              {WEEKS.map(w => (
                <th key={w} scope="col" className="font-medium text-center pb-2">
                  {WEEK_LABELS[w]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIERS.map(tier => (
              <tr key={tier}>
                <th scope="row" className="text-[13px] font-medium text-[#4D4D4D] text-left py-1.5 pr-3">
                  {TIER_LABELS[tier as keyof typeof TIER_LABELS]}
                </th>
                {WEEKS.map(week => {
                  const key = `${week}-${tier}`;
                  const count = lookup.get(key) ?? 0;
                  const provisionalCount = provisionalLookup.get(key) ?? 0;
                  return (
                    <td key={week} className="text-center py-1.5">
                      {heatmap ? (
                        <div
                          className={`mx-auto w-8 h-8 rounded-[8px] ${heatmapBg(count, maxCount)} flex items-center justify-center relative`}
                          title={count > 0 ? cellTitle(count, provisionalCount) : undefined}
                        >
                          {count > 0 && (
                            <span className="text-[13px] font-semibold tabular-nums">{count}</span>
                          )}
                          {provisionalCount > 0 && (
                            <ProvisionalDot title="Includes a provisional classification, session still active" />
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center min-h-[28px]">
                          {count > 0 ? (
                            <div
                              className={`relative min-w-[28px] h-7 rounded-[8px] px-1.5 flex items-center justify-center font-semibold text-[13px] tabular-nums
                                ${TIER_COLOURS[tier as keyof typeof TIER_COLOURS]}
                                ${TIER_TEXT_COLOURS[tier as keyof typeof TIER_TEXT_COLOURS]}`}
                              title={cellTitle(count, provisionalCount)}
                            >
                              {count}
                              {provisionalCount > 0 && (
                                <ProvisionalDot title="Provisional, session still active" />
                              )}
                            </div>
                          ) : (
                            <div className="w-7 h-7 rounded-[8px] bg-[#FAFAFA]" />
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      {!heatmap && (
        <PanelFoot>
          <div className="flex items-center gap-4 flex-wrap">
            {[3, 2, 1].map(t => (
              <span key={t} className="flex items-center gap-1.5 text-[#666666]">
                <span className={`w-2.5 h-2 rounded-full inline-block ${TIER_COLOURS[t as keyof typeof TIER_COLOURS]}`} />
                {TIER_LABELS[t as keyof typeof TIER_LABELS]}
              </span>
            ))}
            {hasProvisional && (
              <span className="flex items-center gap-1.5 text-[#666666]">
                <span className="w-2 h-2 rounded-full bg-[#DC8A00] inline-block" />
                Provisional, session still active
              </span>
            )}
            <span className="ml-auto">Each number is a count of classified tasks</span>
          </div>
        </PanelFoot>
      )}
    </Panel>
  );
}

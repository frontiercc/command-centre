// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { frameworkCoverage, type FrameworkBox, type FitLevel } from '@/lib/pulse/code/framework';
import { Panel, PanelFoot, Tag, Bar } from '@/components/precision/ui';

export const FIT_LABEL: Record<FitLevel, string> = {
  measured: 'Measured',
  proxy: 'Proxy',
  ai_judged: 'AI-judged',
  ai_specific: 'AI-specific',
  not_captured: 'Not captured here',
};
export const FIT_TONE: Record<FitLevel, 'measured' | 'judged' | 'neutral'> = {
  measured: 'measured',
  proxy: 'neutral',
  ai_judged: 'judged',
  ai_specific: 'judged',
  not_captured: 'neutral',
};

export function FrameworkBoxCard({ box }: { box: FrameworkBox }) {
  const { covered, total } = frameworkCoverage(box);
  return (
    <Panel
      title={box.title}
      subtitle={box.subtitle}
      right={total > 0 ? <span className="text-[13px] text-[#8F8F8F] tabular-nums">{covered} of {total} covered here</span> : undefined}
      flush
    >
      {total > 0 && (
        <div className="px-4 pt-2.5 pb-1" title={`Not covered here: ${box.notCaptured.join(', ')}`}>
          <Bar pct={(covered / total) * 100} height={4} color="#C9DEE6" />
        </div>
      )}
      <ul className="m-0 p-0 list-none">
        {box.cells.map((c, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
            <div className="min-w-0">
              <div className="text-[14px] text-[#0A0A0A]">{c.label}</div>
              {c.note && <div className="text-[13px] text-[#8F8F8F]">{c.note}</div>}
            </div>
            <div className="text-right shrink-0 flex flex-col items-end gap-1">
              {c.value === null
                ? <div className="text-[14px] text-[#8F8F8F]">Not measured</div>
                : <div className="text-[14px] font-medium tabular-nums text-[#1F6F8B]">{c.value}</div>}
              <Tag tone={FIT_TONE[c.fit]}>{FIT_LABEL[c.fit]}</Tag>
            </div>
          </li>
        ))}
      </ul>
      <PanelFoot>{box.externalNote}</PanelFoot>
    </Panel>
  );
}

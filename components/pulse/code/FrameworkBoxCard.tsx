// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { FrameworkBox, FitLevel } from '@/lib/pulse/code/framework';
import { Panel, PanelFoot, Tag } from '@/components/precision/ui';

export const FIT_LABEL: Record<FitLevel, string> = {
  measured: 'Measured',
  proxy: 'Proxy',
  ai_specific: 'AI-specific',
  not_captured: 'Not captured here',
};
export const FIT_TONE: Record<FitLevel, 'measured' | 'warn' | 'judged' | 'neutral'> = {
  measured: 'measured',
  proxy: 'warn',
  ai_specific: 'judged',
  not_captured: 'neutral',
};

export function FrameworkBoxCard({ box }: { box: FrameworkBox }) {
  return (
    <Panel title={box.title} subtitle={box.subtitle} flush>
      <ul className="m-0 p-0 list-none">
        {box.cells.map((c, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
            <div className="min-w-0">
              <div className="text-[14px] text-[#0A0A0A]">{c.label}</div>
              {c.note && <div className="text-[13px] text-[#8F8F8F]">{c.note}</div>}
            </div>
            <div className="text-right shrink-0 flex flex-col items-end gap-1">
              <div className="text-[14px] font-medium tabular-nums text-[#0A0A0A]">{c.value ?? '—'}</div>
              <Tag tone={FIT_TONE[c.fit]}>{FIT_LABEL[c.fit]}</Tag>
            </div>
          </li>
        ))}
      </ul>
      <PanelFoot>{box.externalNote}</PanelFoot>
    </Panel>
  );
}

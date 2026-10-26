// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, Bar } from '@/components/precision/ui';

interface OrsBreakdownProps {
  breadth: number | null;
  overlap: number | null;
  propagation: number | null;
}

interface Row {
  key: string;
  label: string;
  description: string;
  value: number | null;
}

/**
 * Resilience explainability — three labelled bars showing the components that
 * compose the Operational Resilience Score. A null component means there was
 * not enough signal to compute it (e.g. no connectors/skills used at T2+).
 */
export default function OrsBreakdown({ breadth, overlap, propagation }: OrsBreakdownProps) {
  const rows: Row[] = [
    { key: 'breadth', label: 'Breadth', description: 'share of active members doing Tier 2+ work', value: breadth },
    { key: 'overlap', label: 'Connector overlap', description: 'shared connector use at Tier 2+', value: overlap },
    { key: 'propagation', label: 'Skill propagation', description: 'skills used by 2 or more people', value: propagation },
  ];

  return (
    <Panel title="What resilience is made of" subtitle="The three parts of the resilience score">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {rows.map(row => {
          const pct = row.value === null ? null : Math.round(Math.min(1, Math.max(0, row.value)) * 100);
          return (
            <div key={row.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-medium text-[#0A0A0A]">{row.label}</span>
                <span className="ml-auto text-[13px] tabular-nums text-[#666666]">{pct === null ? 'Not enough data' : `${pct}%`}</span>
              </div>
              <Bar pct={pct ?? 0} tone={pct === null ? 'neutral' : pct >= 70 ? 'good' : pct >= 50 ? 'measured' : 'warn'} height={4} />
              <span className="text-[13px] text-[#8F8F8F]">{row.description}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Panel, Tag, Muted } from '@/components/precision/ui';

export interface FunnelMonth {
  month: string; // "YYYY-MM"
  tier1: number;
  tier2: number;
  tier3: number;
}

interface AdoptionFunnelProps {
  data: FunnelMonth[];
}

function formatMonth(m: string): string {
  const [year, month] = m.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  // Full 4-digit year — a 2-digit year here ("Jul 26") reads exactly like a
  // day-of-month ("26th July") and was reported as looking wrong for that reason.
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export default function AdoptionFunnel({ data }: AdoptionFunnelProps) {
  if (data.length === 0) {
    return (
      <Panel title="Delegation tier distribution">
        <Muted>Not enough data yet. Distribution will appear after 30 days of activity.</Muted>
      </Panel>
    );
  }

  const chartData = data.map(d => ({
    month: formatMonth(d.month),
    'Tier 1': d.tier1,
    'Tier 2': d.tier2,
    'Tier 3': d.tier3,
  }));

  return (
    <Panel
      title="Delegation tier distribution"
      subtitle="People by their main tier each month, last 6 months"
      right={<Tag tone="judged">AI-judged</Tag>}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 0, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#F2F2F2" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#8F8F8F' }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#8F8F8F' }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ fontSize: 13, borderRadius: 12, border: '1px solid #EAEAEA', backgroundColor: '#FFF' }} cursor={{ fill: '#FAFAFA' }} />
          <Legend wrapperStyle={{ fontSize: 13, paddingTop: 12, color: '#666666' }} />
          <Bar dataKey="Tier 1" stackId="a" fill="#CCD1DB" />
          <Bar dataKey="Tier 2" stackId="a" fill="#8DB2FC" />
          <Bar dataKey="Tier 3" stackId="a" fill="#3D6CE8" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

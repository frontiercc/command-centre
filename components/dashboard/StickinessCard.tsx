// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, PanelFoot, BarRow, Tag } from '@/components/precision/ui';
import { SURFACE_COLOR } from '@/lib/ui/chart-colours';

interface SurfaceStickiness {
  avgDau: number;
  mau: number;
  stickiness: number | null;
}

interface StickinessData {
  cowork: SurfaceStickiness;
  code: SurfaceStickiness;
  chat: SurfaceStickiness;
  computedAt: number;
}

const SURFACES: Array<{
  key: keyof Pick<StickinessData, 'cowork' | 'code' | 'chat'>;
  label: string;
}> = [
  { key: 'cowork', label: 'Cowork' },
  { key: 'code', label: 'Code' },
  { key: 'chat', label: 'Chat' },
];

export default function StickinessCard() {
  const [data, setData] = useState<StickinessData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/pulse/stickiness')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (!data) return null;

  return (
    <Panel
      title="Product stickiness"
      badge={<Tag tone="measured">Measured</Tag>}
      className="h-full flex flex-col"
      bodyClassName="flex-1 flex flex-col"
      flush
    >
      <p className="m-0 px-4 pt-3 pb-1 text-[13px] text-[#8F8F8F]">
        Daily active share of each product&apos;s monthly actives
      </p>
      <div className="flex-1 py-1">
        {SURFACES.map(({ key, label }) => {
          const surface = data[key];
          const pct = surface.stickiness !== null ? Math.round(surface.stickiness * 100) : null;
          return (
            <BarRow
              key={key}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR[key] }} />
                  {label}
                </span>
              }
              value={pct !== null ? `${pct}% DAU/MAU` : '—'}
              pct={pct ?? 0}
              color={SURFACE_COLOR[key]}
              title={`${surface.avgDau.toFixed(1)} daily / ${surface.mau} monthly`}
            />
          );
        })}
      </div>
      <PanelFoot>7-day avg DAU ÷ 30-day MAU</PanelFoot>
    </Panel>
  );
}

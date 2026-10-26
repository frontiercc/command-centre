// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { smoothPath, smoothAreaPath, type ChartPoint } from '@/lib/charts/smooth-path';
import { Panel, Muted, Tag } from '@/components/precision/ui';
import { SURFACE_COLOR } from '@/lib/ui/chart-colours';

interface TrendPoint {
  date: string;
  surface_chat: number;
  surface_code: number;
  surface_cowork: number;
}

const CHART_W = 600;
const CHART_H = 150;
const PAD = 10;

/** Surface colours shared by the dashboard's measured activity views (defined in lib/ui/chart-colours). */
export { SURFACE_COLOR };

function Legend() {
  return (
    <span className="flex items-center gap-4 text-[13px] text-[#666666]">
      {(['chat', 'code', 'cowork'] as const).map(k => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: SURFACE_COLOR[k] }} />
          {k === 'chat' ? 'Chat' : k === 'code' ? 'Code' : 'Cowork'}
        </span>
      ))}
    </span>
  );
}

export default function AdoptionChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <Panel title="14-day adoption trend" className="h-full">
        <div className="h-48 flex items-center justify-center">
          <Muted>No analytics data available yet. Data arrives with a 3-day delay.</Muted>
        </div>
      </Panel>
    );
  }

  const peak = Math.max(
    ...data.map(d => Math.max(d.surface_chat, d.surface_code, d.surface_cowork)),
    1
  );
  // Round scale: four equal whole-number steps, so the axis reads 0 / 10 / 20 / 30 / 40.
  const rawStep = peak / 4;
  const mag = Math.max(1, Math.pow(10, Math.floor(Math.log10(rawStep))));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * mag).filter(Number.isInteger).find(v => v >= rawStep) ?? 10 * mag;
  const maxVal = step * 4;

  // Today is still in progress, so its point is drawn hollow on a dashed segment rather than
  // read as a drop. The API dates are UTC calendar days.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastIsToday = data.length > 1 && data[data.length - 1].date === todayUtc;
  const doneData = lastIsToday ? data.slice(0, -1) : data;

  const toX = (i: number) => {
    if (data.length === 1) return CHART_W / 2;
    return PAD + (i / (data.length - 1)) * (CHART_W - PAD * 2);
  };

  const toY = (val: number) => {
    return CHART_H - PAD - ((val / maxVal) * (CHART_H - PAD * 2));
  };

  type SurfaceKey = 'surface_chat' | 'surface_code' | 'surface_cowork';
  const toPoints = (key: SurfaceKey): ChartPoint[] =>
    doneData.map((d, i) => ({ x: toX(i), y: toY(d[key]) }));

  const buildPath = (key: SurfaceKey) => smoothPath(toPoints(key));

  const buildArea = (key: SurfaceKey) => smoothAreaPath(toPoints(key), CHART_H - PAD);

  // Dashed link from the last full day to today's partial value.
  const partialSegment = (key: SurfaceKey) => {
    const n = data.length;
    return `M ${toX(n - 2).toFixed(1)} ${toY(data[n - 2][key]).toFixed(1)} L ${toX(n - 1).toFixed(1)} ${toY(data[n - 1][key]).toFixed(1)}`;
  };
  const SURFACE_KEYS: Array<[SurfaceKey, 'chat' | 'code' | 'cowork']> = [['surface_chat', 'chat'], ['surface_code', 'code'], ['surface_cowork', 'cowork']];

  // Y-axis grid lines
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => ({
    y: toY(maxVal * pct),
    label: Math.round(maxVal * pct).toLocaleString(),
  }));

  return (
    <Panel
      title="14-day adoption trend"
      badge={<Tag tone="measured">Measured</Tag>}
      right={<Legend />}
      className="h-full"
    >
      <div className="relative" style={{ height: CHART_H + 30 }}>
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full"
          style={{ height: CHART_H }}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Grid lines */}
          {gridLines.map((g, i) => (
            <line key={i} x1={PAD} y1={g.y} x2={CHART_W - PAD} y2={g.y} stroke="#F2F2F2" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}

          {/* Area fills (subtle) */}
          <path d={buildArea('surface_chat')} fill={SURFACE_COLOR.chat} opacity="0.06" />
          <path d={buildArea('surface_code')} fill={SURFACE_COLOR.code} opacity="0.08" />
          <path d={buildArea('surface_cowork')} fill={SURFACE_COLOR.cowork} opacity="0.06" />

          {/* Lines */}
          <path d={buildPath('surface_chat')} fill="none" stroke={SURFACE_COLOR.chat} strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          <path d={buildPath('surface_code')} fill="none" stroke={SURFACE_COLOR.code} strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          <path d={buildPath('surface_cowork')} fill="none" stroke={SURFACE_COLOR.cowork} strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />

          {/* Today so far: dashed, hollow */}
          {lastIsToday && SURFACE_KEYS.map(([key, s]) => (
            <path key={key} d={partialSegment(key)} fill="none" stroke={SURFACE_COLOR[s]} strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          ))}

          {/* Data points */}
          {data.map((d, i) => {
            const partial = lastIsToday && i === data.length - 1;
            return (
              <g key={i}>
                {SURFACE_KEYS.map(([key, s]) => (
                  <circle
                    key={key}
                    cx={toX(i)}
                    cy={toY(d[key])}
                    r="2.5"
                    fill={partial ? '#FFFFFF' : SURFACE_COLOR[s]}
                    stroke={partial ? SURFACE_COLOR[s] : 'none'}
                    strokeWidth={partial ? 1.25 : 0}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            );
          })}
        </svg>

        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between text-[12px] text-[#8F8F8F] tabular-nums py-1" style={{ height: CHART_H }}>
          {[...gridLines].reverse().map((g, i) => (
            <span key={i}>{g.label}</span>
          ))}
        </div>
      </div>

      {/* Date labels */}
      <div className="flex justify-between mt-1 text-[12px] text-[#8F8F8F] tabular-nums px-2">
        {data.length <= 7 ? (
          data.map(d => <span key={d.date}>{d.date.slice(5)}</span>)
        ) : (
          <>
            <span>{data[0].date}</span>
            <span>{data[Math.floor(data.length / 2)].date}</span>
            <span>{data[data.length - 1].date}</span>
          </>
        )}
      </div>
      {lastIsToday && <p className="m-0 mt-1 text-[12px] text-[#8F8F8F]">Today so far shown dashed</p>}
    </Panel>
  );
}

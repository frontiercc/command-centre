// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Panel, Strip, Figure, BarRow, Tag, Muted, Empty } from '@/components/precision/ui';

interface OrgSummary {
  signalCards: { oti: number | null; dds: number | null; psr: number | null; ors: number | null };
  tierCounts: { t1: number; t2: number; t3: number };
  topSkills: Array<{ skill_name: string; usage_count: number; user_count: number }>;
  topConnectors: Array<{ mcp_server: string; usage_count: number; user_count: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSkillName(name: string): string {
  // "engineering:architecture" → "engineering · architecture"
  return name.replace(':', ' · ');
}

function formatConnectorName(name: string): string {
  // Strip mcp__ prefix if present, replace underscores
  return name.replace(/^mcp__/, '').replace(/_/g, ' ');
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** One signal in plain English, the same names and colours as the Work Pulse page. */
function signalFigure({ label, value, sub }: { label: string; value: string | null; sub: string }) {
  return (
    <Figure
      key={label}
      label={label}
      value={value === null ? <span className="text-[#B3B3B3]">—</span> : value}
      tone="judged"
      sub={sub}
    />
  );
}

const TIER_SWATCH = { t1: 'bg-[#CCD1DB]', t2: 'bg-[#8DB2FC]', t3: 'bg-[#3D6CE8]' };

function TierBar({ t1, t2, t3 }: { t1: number; t2: number; t3: number }) {
  const total = t1 + t2 + t3;
  const pct = (n: number) => Math.round((n / total) * 100);

  return (
    <Panel title="Tier mix" subtitle="30 days · all sessions" right={<Tag tone="judged">AI-judged</Tag>} className="h-full">
      {total === 0 ? (
        <Muted>No classified sessions yet.</Muted>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex rounded-full overflow-hidden h-2 gap-px">
            {t1 > 0 && <div style={{ width: `${pct(t1)}%` }} className={TIER_SWATCH.t1} title={`T1 Transactional: ${pct(t1)}%`} />}
            {t2 > 0 && <div style={{ width: `${pct(t2)}%` }} className={TIER_SWATCH.t2} title={`T2 Meaningful: ${pct(t2)}%`} />}
            {t3 > 0 && <div style={{ width: `${pct(t3)}%` }} className={TIER_SWATCH.t3} title={`T3 Frontier: ${pct(t3)}%`} />}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[#666666] tabular-nums">
            <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2 rounded-full inline-block ${TIER_SWATCH.t1}`} />T1 {pct(t1)}%</span>
            <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2 rounded-full inline-block ${TIER_SWATCH.t2}`} />T2 {pct(t2)}%</span>
            <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2 rounded-full inline-block ${TIER_SWATCH.t3}`} />T3 {pct(t3)}%</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

function InvocationList({
  title,
  items,
  nameKey,
  emptyMessage,
  formatName,
}: {
  title: string;
  items: Array<{ usage_count: number; user_count: number; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
}) {
  return (
    <Panel title={title} subtitle="Org, 30 days" flush={items.length > 0}>
      {items.length === 0 ? (
        <Muted>{emptyMessage}</Muted>
      ) : (
        <div className="py-1">
          {items.map((item, i) => {
            const name = item[nameKey] as string;
            const maxUsage = items[0].usage_count;
            const barPct = Math.round((item.usage_count / maxUsage) * 100);
            return (
              <BarRow
                key={name}
                rank={i + 1}
                label={formatName(name)}
                value={`${item.usage_count}× · ${item.user_count} ${item.user_count === 1 ? 'user' : 'users'}`}
                pct={barPct}
                tone="measured"
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PulseBand({ children }: { children?: React.ReactNode }) {
  const [data, setData] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/pulse/org-summary')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const hasData = data && (
    data.signalCards.oti !== null ||
    data.signalCards.dds !== null ||
    data.signalCards.psr !== null ||
    data.signalCards.ors !== null ||
    (data.tierCounts.t1 + data.tierCounts.t2 + data.tierCounts.t3) > 0
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]"><span aria-hidden="true">⚡</span> Work Pulse</h2>
        <span className="text-[13px] text-[#8F8F8F]">How deeply people hand work to Claude</span>
        <Link href="/pulse/cio" className="ml-auto text-[13px] font-medium text-[#245BF3] hover:underline">
          Open Work Pulse
        </Link>
      </div>

      {loading && (
        <Panel><Muted>Loading Pulse data…</Muted></Panel>
      )}

      {!loading && !hasData && (
        <Empty title="No Pulse data yet">Sessions will appear here once classified.</Empty>
      )}

      {/* Keep the nested Developer Pulse strip visible even when Work Pulse has no data */}
      {(loading || !hasData) && children}

      {!loading && hasData && data && (
        <>
          {/* Row 1: the four Cowork signals in plain English + tier bar */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-4">
            <Strip cols={4}>
              {signalFigure({
                label: 'More valuable work',
                value: data.signalCards.oti !== null ? `${data.signalCards.oti.toFixed(2)}×` : null,
                sub: 'Output against your baseline. 1.2× is a meaningful uplift.',
              })}
              {signalFigure({
                label: 'Delegation depth',
                value: data.signalCards.dds !== null ? data.signalCards.dds.toFixed(2) : null,
                sub: 'Average tier, 14 days. 2.0 means frontier work.',
              })}
              {signalFigure({
                label: 'Capabilities created',
                value: data.signalCards.psr !== null ? String(Math.round(data.signalCards.psr)) : null,
                sub: 'Repeatable tasks now owned by Claude, confirmed.',
              })}
              {signalFigure({
                label: 'Resilience',
                value: data.signalCards.ors !== null ? data.signalCards.ors.toFixed(2) : null,
                sub: 'How widely capability is shared. 0.7 means org-owned.',
              })}
            </Strip>
            <TierBar
              t1={data.tierCounts.t1}
              t2={data.tierCounts.t2}
              t3={data.tierCounts.t3}
            />
          </div>

          {/* Developer Pulse strip (passed in) sits directly below the Cowork strip */}
          {children}

          {/* Row 2: Top Skills · Top Connectors */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <InvocationList
              title="Top skills"
              items={data.topSkills}
              nameKey="skill_name"
              emptyMessage="No skill invocations captured yet."
              formatName={formatSkillName}
            />
            <InvocationList
              title="Top connectors"
              items={data.topConnectors}
              nameKey="mcp_server"
              emptyMessage="No connector invocations captured yet."
              formatName={formatConnectorName}
            />
          </div>
        </>
      )}
    </div>
  );
}

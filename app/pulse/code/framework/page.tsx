// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// app/pulse/code/framework/page.tsx
'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { FrameworkBoxCard } from '@/components/pulse/code/FrameworkBoxCard';
import { FigureGrid } from '@/components/pulse/code/CodeStatStrip';
import type { FrameworkBox } from '@/lib/pulse/code/framework';
import type { DxFrameworkResult } from '@/lib/pulse/code/dx-framework';
import { PageBody, Toolbar, Panel, Figure, Tag, Notice, Empty, Muted } from '@/components/precision/ui';

interface Envelope {
  enabled: boolean;
  hasData?: boolean;
  boxes?: FrameworkBox[];
  spendContext?: { spendUsd: number | null; autonomyRatio: number | null };
  dx?: DxFrameworkResult;
}

export default function FrameworkPage() {
  const [data, setData] = useState<Envelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/pulse/code/framework')
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || "Couldn't load this page. Try again."); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'));
  }, []);

  if (error) return (
    <>
      <TopBar title="Dev Framework Alignment" />
      <PageBody><Notice tone="error">{error}</Notice></PageBody>
    </>
  );
  if (!data) return <><TopBar title="Dev Framework Alignment" /><LoadingSpinner /></>;

  if (!data.enabled) return (
    <>
      <TopBar title="Dev Framework Alignment" subtitle="DORA · SPACE · DX Core 4" />
      <PageBody>
        <Empty title="This view is turned off">Enable it in Admin → Developer Pulse → Framework.</Empty>
      </PageBody>
    </>
  );

  const isMock = data.dx?.source === 'mock';

  return (
    <>
      <TopBar title="Dev Framework Alignment" subtitle="How Command Centre's AI-adoption signals map onto DORA · SPACE · DX Core 4" />
      <PageBody>
        {/* Honesty legend */}
        <Toolbar
          left={
            <span className="flex flex-wrap items-center gap-2">
              <span>How to read the tags:</span>
              <Tag tone="measured">Measured</Tag>
              <Tag tone="warn">Proxy</Tag>
              <Tag tone="judged">AI-specific (outside the frameworks)</Tag>
              <Tag>Not captured here</Tag>
            </span>
          }
        />
        <div className="max-w-3xl">
          <Muted>
            These are the AI-contribution slice of your delivery frameworks, measured from Claude Code telemetry.
            They inform, but do not replace, your DORA and DX Core 4 numbers, and imply no causation.
          </Muted>
        </div>

        {isMock && (
          <Notice tone="warn" title={<Tag tone="warn">Demo data</Tag>}>
            Illustrative getDX overlay; connect a real DX workspace to show live numbers.
          </Notice>
        )}

        {!data.hasData && (
          <Notice tone="info">
            Not enough measured data yet. The crosswalk below will fill in as Claude Code telemetry accrues.
          </Notice>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.boxes?.map(b => <FrameworkBoxCard key={b.dimension} box={b} />)}
        </div>

        {/* Optional DX overlay (real framework numbers) */}
        {data.dx?.data && (
          <Panel
            title="Your DX numbers"
            right={isMock ? <Tag tone="warn">Demo data</Tag> : undefined}
            flush
          >
            <div className="px-4 pt-3 text-[13px] font-medium text-[#666666]">DORA</div>
            <FigureGrid cols={4}>
              <Figure label="Deploy freq / wk" value={data.dx.data.dora.deploymentFrequencyPerWeek} />
              <Figure label="Lead time (h)" value={data.dx.data.dora.leadTimeHours} />
              <Figure label="Change-failure %" value={`${data.dx.data.dora.changeFailureRatePct}%`} />
              <Figure label="Restore (h)" value={data.dx.data.dora.timeToRestoreHours} />
            </FigureGrid>
            <div className="px-4 pt-3 text-[13px] font-medium text-[#666666] border-t border-[#F2F2F2]">DX Core 4 and DXI</div>
            <FigureGrid cols={5}>
              <Figure label="Speed" value={data.dx.data.dxCore4.speed} />
              <Figure label="Quality" value={data.dx.data.dxCore4.quality} />
              <Figure label="Effectiveness" value={data.dx.data.dxCore4.effectiveness} />
              <Figure label="Impact" value={data.dx.data.dxCore4.impact} />
              <Figure label="DXI" value={data.dx.data.dxi ?? '—'} />
            </FigureGrid>
          </Panel>
        )}
      </PageBody>
    </>
  );
}

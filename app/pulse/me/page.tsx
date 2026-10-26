// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import StatStrip from '@/components/pulse/StatStrip';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import MilestoneCards from '@/components/pulse/MilestoneCards';
import WeeklyPulse from '@/components/pulse/WeeklyPulse';
import SkillExchange, { type SkillExchangeItem } from '@/components/pulse/SkillExchange';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, Strip, Figure, BarRow, Tag, Notice, Dot, B, C } from '@/components/precision/ui';

interface PersonalPulseData {
  humanTime?: HumanTimeSummary | null;
  canSeeSpendReview?: boolean;
  userId: string | null;
  displayName: string | null;
  department: string | null;
  metrics: {
    oti: number | null;
    dds: number | null;
    psr: number | null;
    ors: number | null;
    oti_early_read?: number | null;
    metric_version?: number | null;
  } | null;
  priorMetrics: {
    oti: number | null;
    dds: number | null;
    psr: number | null;
    ors: number | null;
  } | null;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  journeyGrid: Array<{ week: number; tier: number; count: number }>;
  toolsUsed: ToolUsed[];
  weeklyPulse: { body: string; suggestion: string | null; generated_at: number } | null;
  skillExchange: Array<{ skill_name: string; description: string | null; author_user_id: string | null; run_count: number }>;
  teamId: string | null;
  capabilitiesDetail: {
    count: number;
    confirmed: Array<{ title: string; detected_at: number; confirmed_at: number | null; tier: number | null }>;
    pending: Array<{ id: number; title: string; body: string | null; tier: number | null; detected_at: number }>;
  } | null;
  teamMetrics: { ors: number | null } | null;
  coworkCostUsd?: number;
  coworkFrictionIndex?: number | null;
  topNativeTools?: Array<{ tool_name: string; usage_count: number }>;
  otiUnderReview?: boolean;
}

const TITLE = 'My Pulse';
const SUBTITLE = 'Your personal delegation journey and milestones';

/** Spend for the last 7 days: an absent figure is "Not measured", never $0. */
function spendValue(usd: number | null | undefined) {
  if (usd == null) return <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">Not measured</span>;
  if (usd === 0) return '$0.00';
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

export default function PersonalPulsePage() {
  const searchParams = useSearchParams();
  const viewingUserId = searchParams.get('userId');

  const [data, setData] = useState<PersonalPulseData | null>(null);
  const [skillExchangeData, setSkillExchangeData] = useState<SkillExchangeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pulseStartAt, setPulseStartAt] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const meUrl = viewingUserId ? `/api/pulse/me?userId=${encodeURIComponent(viewingUserId)}` : '/api/pulse/me';
    Promise.all([
      fetch(meUrl).then(r => { if (!r.ok) throw new Error("Couldn't load this page. Try again."); return r.json(); }),
      fetch('/api/pulse/user-prefs').then(r => r.ok ? r.json() : { pulse_start_at: null }),
    ])
      .then(([meData, prefs]) => {
        setData(meData);
        setPulseStartAt(prefs.pulse_start_at ?? null);
        const skillUrl = meData.department
          ? `/api/pulse/skill-exchange?dept=${encodeURIComponent(meData.department)}`
          : meData.userId ? `/api/pulse/skill-exchange?userId=${encodeURIComponent(decodeURIComponent(meData.userId))}` : null;
        if (skillUrl) {
          fetch(skillUrl)
            .then(r => r.ok ? r.json() : { skills: [] })
            .then(d => setSkillExchangeData(d.skills ?? []))
            .catch(() => setSkillExchangeData([]));
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshKey, viewingUserId]);

  if (loading) return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{error}</Notice>
      </PageBody>
    </>
  );

  if (!data) return null;

  async function handleCapabilityAction(id: number, action: 'confirm' | 'dismiss') {
    await fetch('/api/pulse/capabilities', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    setRefreshKey(k => k + 1);
  }

  const pending = data.capabilitiesDetail?.pending ?? [];
  const topTools = data.topNativeTools ?? [];

  return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <PageBody>

        {/* Active since + Spend Review link */}
        {(pulseStartAt || (data.canSeeSpendReview && data.userId)) && (
          <Toolbar
            left={pulseStartAt ? (
              <Dot color={C.good}>
                Active since {new Date(pulseStartAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </Dot>
            ) : undefined}
          >
            {data.canSeeSpendReview && data.userId && (
              <Link href={`/finops/spend-review/${encodeURIComponent(data.userId)}`} className={B.link}>
                {viewingUserId ? 'Spend review' : 'Your spend review'}
              </Link>
            )}
          </Toolbar>
        )}

        {/* 1. Frontier Push hero */}
        <FrontierHero view={data.frontier} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} />

        <HumanTimeCard summary={data.humanTime} surface="cowork" scope="Personal" />

        {/* 2. Stat strip with deltas */}
        <StatStrip
          oti={data.metrics?.oti ?? null}
          dds={data.metrics?.dds ?? null}
          psr={data.capabilitiesDetail?.count ?? data.metrics?.psr ?? null}
          ors={data.teamMetrics?.ors ?? data.metrics?.ors ?? null}
          hideOrs
          otiEarlyRead={data.metrics?.oti_early_read === 1}
          otiUnderReview={data.otiUnderReview ?? false}
          otiDelta={data.priorMetrics ? ((data.metrics?.oti ?? null) !== null && (data.priorMetrics?.oti ?? null) !== null ? Math.round(((data.metrics!.oti! - data.priorMetrics!.oti!) * 100)) / 100 : null) : undefined}
          ddsDelta={data.priorMetrics ? ((data.metrics?.dds ?? null) !== null && (data.priorMetrics?.dds ?? null) !== null ? Math.round(((data.metrics!.dds! - data.priorMetrics!.dds!) * 100)) / 100 : null) : undefined}
          psrDelta={data.priorMetrics ? ((data.metrics?.psr ?? null) !== null && (data.priorMetrics?.psr ?? null) !== null ? Math.round(((data.metrics!.psr! - data.priorMetrics!.psr!) * 100)) / 100 : null) : undefined}
          orsDelta={data.priorMetrics ? ((data.metrics?.ors ?? null) !== null && (data.priorMetrics?.ors ?? null) !== null ? Math.round(((data.metrics!.ors! - data.priorMetrics!.ors!) * 100)) / 100 : null) : undefined}
        />

        {/* 3. Delegation journey grid */}
        <JourneyGrid data={data.journeyGrid} />

        {/* 4. Milestone cards */}
        <MilestoneCards frontier={data.frontier} canReview={data.frontierAccess?.canReview ?? false} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} toolsUsed={data.toolsUsed ?? []} />

        {/* 5. Weekly Pulse — generate button appears in empty state when userId known */}
        <WeeklyPulse
          briefing={data.weeklyPulse}
          userId={data.userId ?? undefined}
          onGenerate={() => setRefreshKey(k => k + 1)}
          action={data.weeklyPulse && data.userId ? (
            <GenerateBriefingButton
              type="user"
              userId={data.userId}
              onComplete={() => setRefreshKey(k => k + 1)}
            />
          ) : undefined}
        />

        {/* 6. Skill exchange */}
        <SkillExchange skills={skillExchangeData} />

        {/* 6b. OTel cowork enrichments — cost + friction */}
        {(data.coworkCostUsd !== undefined || data.coworkFrictionIndex !== undefined) && (
          <Strip cols={2}>
            <Figure
              label="Cowork spend, 7 days"
              value={spendValue(data.coworkCostUsd)}
              sub="API cost of Cowork (OTel) sessions"
            />
            <Figure
              label="Friction index, 7 days"
              value={data.coworkFrictionIndex == null
                ? <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">No data</span>
                : `${(data.coworkFrictionIndex * 100).toFixed(1)}%`}
              sub="Tool failures ÷ total tool calls"
            />
          </Strip>
        )}

        {/* 6c. Top native tools (OTel) */}
        {topTools.length > 0 && (
          <Panel title="Top native tools" subtitle="30 days" right={<Tag tone="measured">Measured</Tag>} flush>
            <div className="py-1">
              {topTools.map((t, i) => (
                <BarRow
                  key={t.tool_name}
                  rank={i + 1}
                  label={t.tool_name}
                  value={`${t.usage_count}×`}
                  pct={Math.round((t.usage_count / topTools[0].usage_count) * 100)}
                  tone="measured"
                />
              ))}
            </div>
          </Panel>
        )}

        {/* 7. Pending capability confirmations */}
        {pending.length > 0 && (
          <Panel
            title="Capabilities to review"
            badge={<Tag tone="warn">{pending.length}</Tag>}
            subtitle="Claude may have taken on these types of work for the first time. Confirm to track them."
            flush
          >
            <ul className="m-0 p-0 list-none">
              {pending.map(c => (
                <li key={c.id} className="px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">{cleanTitle(c.title)}</p>
                    {c.body && <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F] line-clamp-1">{c.body}</p>}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button type="button" onClick={() => handleCapabilityAction(c.id, 'confirm')} className={B.primary}>
                      Confirm
                    </button>
                    <button type="button" onClick={() => handleCapabilityAction(c.id, 'dismiss')} className={B.secondary}>
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}

      </PageBody>
    </>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import StatStrip from '@/components/pulse/StatStrip';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import MilestoneCards from '@/components/pulse/MilestoneCards';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import WeeklyPulse from '@/components/pulse/WeeklyPulse';
import SkillExchange, { type SkillExchangeItem } from '@/components/pulse/SkillExchange';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, Tag, Notice, B } from '@/components/precision/ui';

interface PersonalPulseData {
  humanTime?: HumanTimeSummary | null;
  userId: string | null;
  displayName: string | null;
  department: string | null;
  metrics: {
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
  teamId: string | null;
  capabilitiesDetail: {
    count: number;
    confirmed: Array<{ title: string; detected_at: number; confirmed_at: number | null; tier: number | null }>;
    pending: Array<{ id: number; title: string; body: string | null; tier: number | null; detected_at: number }>;
  } | null;
  teamMetrics: { ors: number | null } | null;
}

export default function UserPulsePage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const [data, setData] = useState<PersonalPulseData | null>(null);
  const [skillExchangeData, setSkillExchangeData] = useState<SkillExchangeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Admin gate — check session before fetching
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => {
        if (!d.authenticated || d.user?.role !== 'admin') {
          router.replace('/audit');
        }
      })
      .catch(() => router.replace('/audit'));
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    fetch(`/api/pulse/me?userId=${encodeURIComponent(userId)}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(meData => {
        setData(meData);
        const skillUrl = meData.department
          ? `/api/pulse/skill-exchange?dept=${encodeURIComponent(meData.department)}`
          : `/api/pulse/skill-exchange?userId=${userId}`; // userId from useParams already encoded
        fetch(skillUrl)
          .then(r => r.ok ? r.json() : { skills: [] })
          .then(d => setSkillExchangeData(d.skills ?? []))
          .catch(() => setSkillExchangeData([]));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [userId, refreshKey]);

  if (loading) return (
    <>
      <TopBar title="Pulse" subtitle="User delegation journey and milestones" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title="Pulse" subtitle="User delegation journey and milestones" />
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

  const userName = data.displayName ?? userId;

  return (
    <>
      <TopBar
        title={`Pulse: ${userName}`}
        subtitle="Admin view: delegation journey and milestones"
      />
      <PageBody>

        {/* Back link */}
        {data.department && (
          <Toolbar
            left={
              <Link href={`/pulse/dept?dept=${encodeURIComponent(data.department)}`} className={B.link}>
                ← {data.department} department
              </Link>
            }
          />
        )}

        {/* 1. Frontier Push hero */}
        <FrontierHero view={data.frontier} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} />

        <HumanTimeCard summary={data.humanTime} surface="cowork" scope="Personal" />

        {/* 2. Stat strip */}
        <StatStrip
          oti={data.metrics?.oti ?? null}
          dds={data.metrics?.dds ?? null}
          psr={data.capabilitiesDetail?.count ?? data.metrics?.psr ?? null}
          ors={data.teamMetrics?.ors ?? data.metrics?.ors ?? null}
          hideOrs
        />

        {/* 3. Delegation journey grid */}
        <JourneyGrid data={data.journeyGrid} />

        {/* 4. Milestone cards */}
        <MilestoneCards frontier={data.frontier} canReview={data.frontierAccess?.canReview ?? false} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} toolsUsed={data.toolsUsed ?? []} />

        {/* 5. Weekly Pulse */}
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

        {/* 7. Pending capability confirmations */}
        {data.capabilitiesDetail?.pending && data.capabilitiesDetail.pending.length > 0 && (
          <Panel
            title="Capabilities to review"
            badge={<Tag tone="warn">{data.capabilitiesDetail.pending.length}</Tag>}
            subtitle="Claude may have taken on these types of work for the first time. Confirm to track them."
            flush
          >
            <ul className="m-0 p-0 list-none">
              {data.capabilitiesDetail.pending.map(c => (
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

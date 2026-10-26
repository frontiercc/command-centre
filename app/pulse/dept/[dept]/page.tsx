// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import StatStrip from '@/components/pulse/StatStrip';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import MilestoneCards from '@/components/pulse/MilestoneCards';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import ConcentrationRisk from '@/components/pulse/ConcentrationRisk';
import FrontierFeed from '@/components/pulse/FrontierFeed';
import MemberTable, { MemberRow } from '@/components/pulse/MemberTable';
import OrsBreakdown from '@/components/pulse/OrsBreakdown';
import { PageBody, Panel, SubHead, Strip, Figure, Tag, Notice, Muted, B } from '@/components/precision/ui';

interface DeptPulseData {
  dept: string;
  members: Array<{ id: string; display_name: string | null; email: string }>;
  memberMetrics: MemberRow[];
  metrics: {
    oti: number | null; dds: number | null; psr: number | null;
    ors: number | null; event_count: number;
    tier_1_count: number; tier_2_count: number; tier_3_count: number;
    ors_breadth?: number | null; ors_overlap?: number | null; ors_propagation?: number | null;
  } | null;
  priorMetrics: {
    oti: number | null; dds: number | null; psr: number | null; ors: number | null;
  } | null;
  teamMetrics: {
    psr: number | null; ors: number | null;
    orsBreadth?: number | null; orsOverlap?: number | null; orsPropagation?: number | null;
  } | null;
  journeyHeatmap: Array<{ week: number; tier: number; count: number }>;
  concentrationRisk: Array<{ user_id: string; display_name: string | null; sole_workflows: number }>;
  concentrationDetail: Array<{ user_id: string; display_name: string | null; task_types: string[] }>;
  skillConcentration: Array<{ user_id: string; display_name: string | null; skills: string[] }>;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  toolsUsed: ToolUsed[];
  deptBriefing: {
    body: string;
    suggestion: string | null;
    generated_at: number;
  } | null;
  coworkCostUsd?: number;
  coworkFrictionIndex?: number | null;
  docSessions?: { sessions_with_uploads: number; total_uploads: number };
}

function delta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return Math.round((current - prior) * 100) / 100;
}

/** Spend for the last 7 days: an absent figure is "Not measured", never $0. */
function spendValue(usd: number | null | undefined) {
  if (usd == null) return <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">Not measured</span>;
  if (usd === 0) return '$0.00';
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

export default function DeptPulsePage() {
  const { dept } = useParams<{ dept: string }>();
  const deptDecoded = dept ? decodeURIComponent(dept) : '';
  const router = useRouter();

  // Redirect to picker page so the dropdown is always available
  useEffect(() => {
    if (deptDecoded) {
      router.replace(`/pulse/dept?dept=${encodeURIComponent(deptDecoded)}`);
    }
  }, [deptDecoded, router]);
  const [data, setData] = useState<DeptPulseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState('');
  const [generatingBriefing, setGeneratingBriefing] = useState(false);
  const [briefingMsg, setBriefingMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => { if (d.authenticated) setUserRole(d.user?.role ?? ''); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!dept) return;
    fetch(`/api/pulse/dept/${encodeURIComponent(dept)}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dept]);

  if (loading) return (
    <>
      <TopBar title={`Department: ${deptDecoded}`} subtitle="Department delegation journey, resilience, and frontier events" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title={`Department: ${deptDecoded}`} subtitle="Department delegation journey, resilience, and frontier events" />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{error}</Notice>
      </PageBody>
    </>
  );

  if (!data) return null;

  const handleGenerateBriefing = async () => {
    setGeneratingBriefing(true);
    setBriefingMsg(null);
    try {
      const res = await fetch('/api/pulse/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dept', dept: deptDecoded }),
      });
      if (!res.ok) throw new Error("Couldn't generate the briefing. Try again.");
      setBriefingMsg('Briefing generated. Reload to see it.');
    } catch (err) {
      setBriefingMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setGeneratingBriefing(false);
    }
  };

  const otiDelta = delta(data.metrics?.oti ?? null, data.priorMetrics?.oti ?? null);
  const ddsDelta = delta(data.metrics?.dds ?? null, data.priorMetrics?.dds ?? null);
  const psrDelta = delta(data.metrics?.psr ?? null, data.priorMetrics?.psr ?? null);
  const orsDelta = delta(data.metrics?.ors ?? null, data.priorMetrics?.ors ?? null);

  const showSpend = data.coworkCostUsd !== undefined || data.coworkFrictionIndex !== undefined;
  const showDocs = !!data.docSessions && data.docSessions.sessions_with_uploads > 0;
  const activityCols = (showSpend ? 2 : 0) + (showDocs ? 2 : 0);

  return (
    <>
      <TopBar
        title={`Department: ${data.dept}`}
        subtitle={`${data.members.length} member${data.members.length === 1 ? '' : 's'} · delegation journey and resilience`}
      />
      <PageBody>

        {/* 1. Frontier hero */}
        <FrontierHero view={data.frontier} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} />

        {/* 2. Dept stat strip with deltas */}
        <StatStrip
          oti={data.metrics?.oti ?? null}
          dds={data.metrics?.dds ?? null}
          psr={data.teamMetrics?.psr ?? data.metrics?.psr ?? null}
          ors={data.teamMetrics?.ors ?? data.metrics?.ors ?? null}
          otiDelta={otiDelta}
          ddsDelta={ddsDelta}
          psrDelta={psrDelta}
          orsDelta={orsDelta}
        />

        {/* 2b. ORS explainability breakdown — mirrors the teamMetrics ?? metrics
             precedence used for the ORS score itself above, so the breakdown
             always explains the number actually shown. */}
        <OrsBreakdown
          breadth={data.teamMetrics?.orsBreadth ?? data.metrics?.ors_breadth ?? null}
          overlap={data.teamMetrics?.orsOverlap ?? data.metrics?.ors_overlap ?? null}
          propagation={data.teamMetrics?.orsPropagation ?? data.metrics?.ors_propagation ?? null}
        />

        {/* 3. Milestone cards */}
        <MilestoneCards frontier={data.frontier} canReview={data.frontierAccess?.canReview ?? false} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} toolsUsed={data.toolsUsed ?? []} />

        {/* 4. Dept briefing */}
        <Panel
          title="Department briefing"
          badge={data.deptBriefing ? <Tag tone="judged">AI summary</Tag> : undefined}
          right={
            <button
              type="button"
              onClick={handleGenerateBriefing}
              disabled={generatingBriefing}
              className={B.accent}
            >
              {generatingBriefing ? 'Generating…' : 'Generate briefing'}
            </button>
          }
        >
          {briefingMsg && <p className="m-0 mb-2 text-[13px] text-[#666666]" role="status">{briefingMsg}</p>}
          {data.deptBriefing ? (
            <div className="flex flex-col gap-2.5">
              {data.deptBriefing.body.split('\n\n').map((para, i) => (
                <p key={i} className="m-0 text-[14px] text-[#333333] leading-6">
                  {para}
                </p>
              ))}
              {data.deptBriefing.suggestion && (
                <div className="pt-3 border-t border-[#F2F2F2]">
                  <SubHead>Manager notes</SubHead>
                  {data.deptBriefing.suggestion.split('\n\n').map((line, i) => (
                    <p key={i} className="m-0 text-[13px] text-[#666666] leading-5">{line}</p>
                  ))}
                </div>
              )}
              <p className="m-0 text-[13px] text-[#8F8F8F]">
                Generated {new Date(data.deptBriefing.generated_at * 1000).toLocaleDateString('en-GB', {
                  day: 'numeric', month: 'short', year: 'numeric',
                })}
              </p>
            </div>
          ) : (
            <Muted>
              {(userRole === 'admin' || userRole === 'manager')
                ? 'No briefing generated yet. Click "Generate briefing" above.'
                : 'No department briefing available yet.'}
            </Muted>
          )}
        </Panel>

        {/* 3. Dept journey heatmap */}
        <JourneyGrid data={data.journeyHeatmap} />

        {/* 4. Concentration risk */}
        <ConcentrationRisk
          risks={data.concentrationRisk}
          ors={data.teamMetrics?.ors ?? data.metrics?.ors ?? null}
          detail={data.concentrationDetail}
          skillConcentration={data.skillConcentration}
        />

        {/* 5. Frontier feed */}
        {data.frontier && <FrontierFeed items={data.frontier.feed} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} />}

        {/* 5b/5c. Dept Cowork spend, friction and document sessions */}
        {activityCols > 0 && (
          <Strip cols={activityCols as 2 | 4}>
            {showSpend && (
              <Figure
                label="Dept Cowork spend, 7 days"
                value={spendValue(data.coworkCostUsd)}
                sub="Total API cost of Cowork (OTel) sessions"
              />
            )}
            {showSpend && (
              <Figure
                label="Dept friction index, 7 days"
                value={data.coworkFrictionIndex == null
                  ? <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">No data</span>
                  : `${(data.coworkFrictionIndex * 100).toFixed(1)}%`}
                sub="Tool failures ÷ total tool calls"
              />
            )}
            {showDocs && (
              <Figure
                label="Document sessions, 30 days"
                value={data.docSessions!.sessions_with_uploads}
                unit="sessions with uploads"
                sub="Cowork sessions where one or more files were attached"
              />
            )}
            {showDocs && (
              <Figure
                label="Files uploaded, 30 days"
                value={data.docSessions!.total_uploads}
                unit="files"
                sub="Across those sessions"
              />
            )}
          </Strip>
        )}

        {/* 6. Member list */}
        <MemberTable members={data.memberMetrics} />

      </PageBody>
    </>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import StatStrip from '@/components/pulse/StatStrip';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import MilestoneCards from '@/components/pulse/MilestoneCards';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import ConcentrationRisk from '@/components/pulse/ConcentrationRisk';
import FrontierFeed from '@/components/pulse/FrontierFeed';
import MemberTable from '@/components/pulse/MemberTable';
import type { MemberRow } from '@/components/pulse/MemberTable';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import WeeklyPulse from '@/components/pulse/WeeklyPulse';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import OrsBreakdown from '@/components/pulse/OrsBreakdown';
import DelegationBands, { type BandSegment, type PersonDelegation } from '@/components/pulse/DelegationBands';
import CoachingPrompts, { type CoachingPromptItem } from '@/components/pulse/CoachingPrompts';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Strip, Figure, Notice, B, cx } from '@/components/precision/ui';

// Based on DeptPulseData from app/pulse/dept/[dept]/page.tsx (a redirect-only
// legacy page) but intentionally diverges: `delegation?` exists only here.
interface DeptData {
  humanTime?: HumanTimeSummary | null;
  dept: string;
  members: Array<{ id: string; display_name: string | null; email: string }>;
  memberMetrics: MemberRow[];
  metrics: {
    oti: number | null; dds: number | null; psr: number | null;
    ors: number | null; event_count: number;
    tier_1_count: number; tier_2_count: number; tier_3_count: number;
    ors_breadth?: number | null; ors_overlap?: number | null; ors_propagation?: number | null;
  } | null;
  priorMetrics: { oti: number | null; dds: number | null; psr: number | null; ors: number | null } | null;
  teamMetrics: {
    psr: number | null; ors: number | null;
    orsBreadth?: number | null; orsOverlap?: number | null; orsPropagation?: number | null;
  } | null;
  journeyHeatmap: Array<{ week: number; tier: number; count: number }>;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  toolsUsed: ToolUsed[];
  concentrationRisk: Array<{ user_id: string; display_name: string | null; sole_workflows: number }>;
  concentrationDetail: Array<{ user_id: string; display_name: string | null; task_types: string[] }>;
  deptBriefing: { body: string; suggestion: string | null; generated_at: number } | null;
  coworkCostUsd?: number;
  coworkFrictionIndex?: number | null;
  docSessions?: { sessions_with_uploads: number; total_uploads: number };
  delegation?: {
    window: 13 | 26 | 52;
    bands: BandSegment[];
    bandsDataWeeks: number;
    people: PersonDelegation[];
  };
  coaching?: { prompts: CoachingPromptItem[] };
}

interface DeptListRow { dept: string; member_count: number }

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

export default function DeptPickerPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [depts, setDepts] = useState<DeptListRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [deptData, setDeptData] = useState<DeptData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegationWeeks, setDelegationWeeks] = useState<13 | 26 | 52>(13);

  const selectedDept = searchParams.get('dept') ?? '';

  // Load dept list once
  useEffect(() => {
    fetch('/api/pulse/depts')
      .then(r => r.json())
      .then(d => {
        const list: DeptListRow[] = (d.depts ?? []).map((row: { department?: string; member_count?: number }) => ({
          dept: row.department ?? '',
          member_count: row.member_count ?? 0,
        })).filter((r: DeptListRow) => r.dept);
        setDepts(list);
        // Auto-select first dept if nothing in URL
        if (!searchParams.get('dept') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('dept', list[0].dept);
          router.replace(`/pulse/dept?${params.toString()}`);
        }
      })
      .catch(() => {})
      .finally(() => setDeptsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load dept data whenever selection changes. The full-page spinner only
  // shows when the DEPARTMENT changes — a delegation window (13/26/52) change
  // refetches quietly and swaps in place, matching the CIO page, so the pill
  // click does not blank the whole page or lose the scroll position.
  const loadedDeptRef = useRef<string | null>(null);
  const loadDept = useCallback((dept: string) => {
    if (!dept) return;
    if (loadedDeptRef.current !== dept) setDataLoading(true);
    setError(null);
    fetch(`/api/pulse/dept/${encodeURIComponent(dept)}?weeks=${delegationWeeks}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(d => { loadedDeptRef.current = dept; setDeptData(d); })
      .catch(e => setError(e.message))
      .finally(() => setDataLoading(false));
  }, [delegationWeeks]);

  useEffect(() => {
    if (selectedDept) loadDept(selectedDept);
  }, [selectedDept, loadDept]);

  const handleSelect = (dept: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('dept', dept);
    router.push(`/pulse/dept?${params.toString()}`);
  };

  return (
    <>
      <TopBar
        title="Departments"
        subtitle={selectedDept ? `Delegation pulse · ${selectedDept}` : 'Select a department'}
      />
      <PageBody>

        {/* Dept picker */}
        <Toolbar
          left={deptData && !dataLoading
            ? `${deptData.members.length} member${deptData.members.length !== 1 ? 's' : ''}`
            : undefined}
        >
          {deptsLoading ? (
            <div className="h-[30px] w-64 bg-[#F2F2F2] rounded-[10px] animate-pulse" />
          ) : (
            <select
              aria-label="Department"
              value={selectedDept}
              onChange={e => handleSelect(e.target.value)}
              className={cx(B.select, 'min-w-[200px]')}
            >
              {depts.length === 0 && (
                <option value="">No departments found</option>
              )}
              {depts.map(d => (
                <option key={d.dept} value={d.dept}>
                  {d.dept} ({d.member_count} member{d.member_count !== 1 ? 's' : ''})
                </option>
              ))}
            </select>
          )}
        </Toolbar>

        {/* Content */}
        {dataLoading && <LoadingSpinner />}

        {error && (
          <Notice tone="error" title="Failed to load.">{error}</Notice>
        )}

        {deptData && !dataLoading && (() => {
          const d = deptData;
          const showSpend = d.coworkCostUsd !== undefined || d.coworkFrictionIndex !== undefined;
          const showDocs = !!d.docSessions && d.docSessions.sessions_with_uploads > 0;
          const activityCols = (showSpend ? 2 : 0) + (showDocs ? 2 : 0);
          return (
            <>
              <FrontierHero view={d.frontier} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} />

              <HumanTimeCard summary={d.humanTime} surface="cowork" scope={d.dept} />

              <StatStrip
                oti={d.metrics?.oti ?? null}
                dds={d.metrics?.dds ?? null}
                psr={d.teamMetrics?.psr ?? d.metrics?.psr ?? null}
                ors={d.teamMetrics?.ors ?? d.metrics?.ors ?? null}
                otiDelta={delta(d.metrics?.oti ?? null, d.priorMetrics?.oti ?? null)}
                ddsDelta={delta(d.metrics?.dds ?? null, d.priorMetrics?.dds ?? null)}
                psrDelta={delta(d.metrics?.psr ?? null, d.priorMetrics?.psr ?? null)}
                orsDelta={delta(d.metrics?.ors ?? null, d.priorMetrics?.ors ?? null)}
              />

              {/* ORS explainability breakdown — mirrors the teamMetrics ?? metrics
                  precedence used for the ORS score itself above. */}
              <OrsBreakdown
                breadth={d.teamMetrics?.orsBreadth ?? d.metrics?.ors_breadth ?? null}
                overlap={d.teamMetrics?.orsOverlap ?? d.metrics?.ors_overlap ?? null}
                propagation={d.teamMetrics?.orsPropagation ?? d.metrics?.ors_propagation ?? null}
              />

              <JourneyGrid data={d.journeyHeatmap} heatmap={true} />

              <MilestoneCards frontier={d.frontier} canReview={d.frontierAccess?.canReview ?? false} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} toolsUsed={d.toolsUsed ?? []} />

              <WeeklyPulse
                briefing={d.deptBriefing}
                action={
                  d.deptBriefing ? (
                    <GenerateBriefingButton
                      type="dept"
                      dept={d.dept}
                      onComplete={() => loadDept(selectedDept)}
                    />
                  ) : (
                    <GenerateBriefingButton
                      type="dept"
                      dept={d.dept}
                      label="Generate dept briefing"
                      onComplete={() => loadDept(selectedDept)}
                    />
                  )
                }
              />

              <ConcentrationRisk
                risks={d.concentrationRisk}
                ors={d.teamMetrics?.ors ?? d.metrics?.ors ?? null}
                detail={d.concentrationDetail}
              />

              {d.frontier && (
                <FrontierFeed items={d.frontier.feed} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} />
              )}

              {/* Cowork spend, friction and document sessions: measured, one strip. */}
              {activityCols > 0 && (
                <Strip cols={activityCols as 2 | 4}>
                  {showSpend && (
                    <Figure
                      label="Dept Cowork spend, 7 days"
                      value={spendValue(d.coworkCostUsd)}
                      sub="Total API cost of Cowork (OTel) sessions"
                    />
                  )}
                  {showSpend && (
                    <Figure
                      label="Dept friction index, 7 days"
                      value={d.coworkFrictionIndex == null
                        ? <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">No data</span>
                        : `${(d.coworkFrictionIndex * 100).toFixed(1)}%`}
                      sub="Tool failures ÷ total tool calls"
                    />
                  )}
                  {showDocs && (
                    <Figure
                      label="Document sessions, 30 days"
                      value={d.docSessions!.sessions_with_uploads}
                      unit="sessions with uploads"
                      sub="Cowork sessions where one or more files were attached"
                    />
                  )}
                  {showDocs && (
                    <Figure
                      label="Files uploaded, 30 days"
                      value={d.docSessions!.total_uploads}
                      unit="files"
                      sub="Across those sessions"
                    />
                  )}
                </Strip>
              )}

              {d.delegation && (
                <DelegationBands
                  bands={d.delegation.bands}
                  bandsDataWeeks={d.delegation.bandsDataWeeks}
                  people={d.delegation.people}
                  window={d.delegation.window}
                  onWindowChange={setDelegationWeeks}
                />
              )}

              {/* No wrapping spacer div here: CoachingPrompts
                  returns null when there is truly nothing to show, so an
                  empty wrapper never leaves a stray gap once every prompt has
                  been marked done. PageBody's gap spaces it. */}
              {d.coaching && <CoachingPrompts prompts={d.coaching.prompts} />}

              <MemberTable members={d.memberMetrics} />
            </>
          );
        })()}

        {!dataLoading && !deptData && !error && selectedDept && (
          <p className="m-0 text-[13px] text-[#8F8F8F]">Loading department data…</p>
        )}

      </PageBody>
    </>
  );
}

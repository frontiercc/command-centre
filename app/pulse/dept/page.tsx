// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  WorkPanel, TaskList, DeeperPanel, ByHandPanel, PeoplePanel, ProducedPanel, ColleagueToolsPanel,
  type ByHand, type PersonRow, type Who, type DrillKind,
} from '@/components/pulse/MyPulsePanels';
import { Frame } from '@/components/pulse/WorkPulseOverview';
import type { BandSegment, PersonDelegation } from '@/components/pulse/DelegationBands';
import type { MyPeriod, PulsePeriod } from '@/lib/pulse/period-shape';
import type { TierNames } from '@/lib/pulse/tier-names';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import ConcentrationRisk from '@/components/pulse/ConcentrationRisk';
import type { MemberRow } from '@/components/pulse/MemberTable';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import CoachingPrompts, { type CoachingPromptItem } from '@/components/pulse/CoachingPrompts';
import { PageBody, Toolbar, Notice, B, cx } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';

// Based on DeptPulseData from app/pulse/dept/[dept]/page.tsx (a redirect-only
// legacy page) but intentionally diverges: `delegation?` exists only here.
interface DeptData {
  humanTime?: ByHand | null;
  period?: MyPeriod | null;
  memberRows?: PersonRow[];
  tierNames?: TierNames | null;
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
  skillConcentration?: Array<{ user_id: string; display_name: string | null; skills: string[] }>;
  deptBriefing: { body: string; suggestion: string | null; generated_at: number } | null;
  coworkCostUsd?: number;
  chatgptCostUsd?: number | null;
  chatgptUnpricedModels?: string[];
  coworkFrictionIndex?: number | null;
  openaiPresent?: boolean;
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

export default function DeptPickerPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [depts, setDepts] = useState<DeptListRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [deptData, setDeptData] = useState<DeptData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegationWeeks] = useState<13 | 26 | 52>(13);
  // The All / Claude / OpenAI switch, shared with the dashboard and Executive View.
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();

  const [period, setPeriod] = useState<PulsePeriod>('quarter');
  const [drill, setDrill] = useState<DrillKind | null>(null);

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
    if (!vendorReady) return; // the saved view is read after the page loads
    if (!dept) return;
    if (loadedDeptRef.current !== dept) setDataLoading(true);
    setError(null);
    fetch(`/api/pulse/dept/${encodeURIComponent(dept)}?weeks=${delegationWeeks}&vendor=${vendor}&period=${period}`)
      .then(async r => {
        if (r.ok) return r.json();
        // A refusal says why, so nobody retries what can never load; the
        // previous department's figures are cleared, not left under this name.
        const body = await r.json().catch(() => ({}));
        if (r.status === 403) throw new Error('You can only view your own department.');
        throw new Error(body.message || "Couldn't load this page. Try again.");
      })
      .then(d => { loadedDeptRef.current = dept; setDeptData(d); })
      .catch(e => { loadedDeptRef.current = null; setDeptData(null); setError(e.message); })
      .finally(() => setDataLoading(false));
  }, [delegationWeeks, vendor, vendorReady, period]);

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
      <PageBody className="dash-compact">

        {/* Dept picker */}
        <Toolbar
          left={
            <span className="flex items-center gap-3 flex-wrap">
              {deptsLoading ? (
                <span className="block h-8 w-64 bg-[#F2F2F2] rounded-[10px] animate-pulse" />
              ) : (
                <select
                  aria-label="Department"
                  value={selectedDept}
                  onChange={e => handleSelect(e.target.value)}
                  className={cx(B.select, 'min-w-[240px] text-[14px]')}
                >
                  {depts.length === 0 && <option value="">No departments found</option>}
                  {depts.map(d => (
                    <option key={d.dept} value={d.dept}>
                      {d.dept} ({d.member_count} member{d.member_count !== 1 ? 's' : ''})
                    </option>
                  ))}
                </select>
              )}
            </span>
          }
        >
          <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={deptData?.openaiPresent ?? false} labels={WORK_PULSE_VENDOR_LABELS} />
        </Toolbar>
        {vendor !== 'all' && !openaiOnly && (
          <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">
            Showing {WORK_PULSE_VENDOR_LABELS[vendor]} only{vendor === 'openai' ? ': ChatGPT Chat and ChatGPT Work' : ': Claude Chat, Claude Cowork and Claude in Office/Google'}.
          </p>
        )}

        {/* Content */}
        {dataLoading && <LoadingSpinner />}

        {error && (
          <Notice tone="error" title={error.startsWith('You can only') ? 'Not available.' : 'Failed to load.'}>{error}</Notice>
        )}

        {deptData && !dataLoading && (() => {
          const d = deptData;
          const q = d.period ?? null;
          const who: Who = { you: false, name: d.dept };
          const product = vendor === 'openai' ? 'ChatGPT' : vendor === 'claude' || !d.openaiPresent ? 'Claude' : 'Claude and ChatGPT';
          const names = d.tierNames ?? undefined;
          const thenVsNow = new Map((d.delegation?.people ?? [])
            .filter(p => p.thenVsNow)
            .map(p => [p.userId, { then: p.thenVsNow!.then, now: p.thenVsNow!.now, arrow: p.thenVsNow!.arrow }]));

          return (
            <>
              {q ? (
                <>
                  {/* 1. The department's work, over the chosen period */}
                  <WorkPanel
                    q={q}
                    product={product}
                    who={who}
                    period={period}
                    onPeriod={setPeriod}
                    onDrill={setDrill}
                    drill={drill}
                    reviewHref={null}
                    names={names}
                  />

                  {drill && (
                    <TaskList kind={drill} period={period} userId={null} who={who} onClose={() => setDrill(null)} names={names} />
                  )}

                  {/* 2. Best work this week */}
                  <FrontierHero view={d.frontier} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} />

                  {/* 3. Is the department's work getting deeper? */}
                  <DeeperPanel q={q} who={who} names={names} />

                  {/* 4 and 5: what the work took, and what came out of it */}
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ByHandPanel h={d.humanTime} who={who} />
                    <ProducedPanel q={q} who={who} period={period} />
                  </div>

                  {/* 6. Who is in it */}
                  <PeoplePanel rows={d.memberRows ?? []} dept={d.dept} names={names} thenVsNow={thenVsNow} />

                  {/* 7 and 8: the two people actions */}
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ConcentrationRisk
                      risks={d.concentrationRisk}
                      ors={d.teamMetrics?.ors ?? d.metrics?.ors ?? null}
                      detail={d.concentrationDetail}
                      skillConcentration={d.skillConcentration}
                      names={names}
                    />
                    <CoachingPrompts prompts={d.coaching?.prompts ?? []} />
                  </div>

                  {/* 9. What colleagues elsewhere use */}
                  <ColleagueToolsPanel q={q} who={who} department={d.dept} period={period} />
                </>
              ) : (
                <Notice tone="info" title="No work yet.">Nothing has been recorded for this department yet.</Notice>
              )}

              {/* 10. The department's briefing */}
              <Frame
                title={`${d.dept}, in a paragraph`}
                tag="AI summary"
                period={
                  <span className="inline-flex items-center gap-2">
                    {d.deptBriefing && new Date(d.deptBriefing.generated_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                    <GenerateBriefingButton type="dept" dept={d.dept} onComplete={() => loadDept(selectedDept)} />
                  </span>
                }
              >
                {d.deptBriefing ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2 text-[14px] leading-[22px] text-[#1A1A1A]">
                    <div>{d.deptBriefing.body.split(/\n\s*\n/).filter(t => t.trim()).map((t, i) => <p key={i} className="m-0 mb-2 last:mb-0">{t}</p>)}</div>
                    {d.deptBriefing.suggestion && <p className="m-0"><b className="font-semibold">Recommendation:</b> {d.deptBriefing.suggestion}</p>}
                  </div>
                ) : (
                  <p className="m-0 mt-2 text-[13px] text-[#8F8F8F]">No paragraph yet. Use Generate now, or wait for the scheduled run.</p>
                )}
              </Frame>
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

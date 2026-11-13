// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { WorkPulsePanel, type OrgSummary as PulseOrgSummary } from '@/components/pulse/PulseBand';
import { UseCasesNext, BiggerJobs, DeptRealWork, Produced, Products, NewWaysOfWorking } from '@/components/pulse/WorkPulseOverview';
import type { ByProductData } from '@/components/pulse/ByProductPanel';
import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Link from 'next/link';
import CapabilityLog from '@/components/pulse/CapabilityLog';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import type { FunnelMonth } from '@/components/pulse/AdoptionFunnel';
import type { BandSegment, PersonDelegation } from '@/components/pulse/DelegationBands';
import type { ActNextItem, DeptProcessBoxItem } from '@/components/pulse/ActNextPanel';
import { PageBody, Toolbar, Panel, Tag, Muted, Notice, B } from '@/components/precision/ui';
import type { SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import type { HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';

interface WorkMixItem {
  task_type: string;
  messages: number;
  tier3: number;
  tier2: number;
  tier1: number;
  claude?: number;
  openai?: number;
}

type RowVendor = 'claude' | 'openai';

interface OrgSummarySlice {
  topSkills: Array<{ skill_name: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
  topConnectors: Array<{ mcp_server: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
  topNativeTools?: Array<{ tool_name: string; usage_count: number; user_count: number }>;
  docSessions?: { sessions_with_uploads: number; total_uploads: number };
  workMix?: WorkMixItem[];
  sessionOutput?: SessionOutputReport | null;
  byProduct?: ByProductData | null;
  humanTime?: HumanTimeSummary | null;
}

interface HeroFigures {
  weeklyActive: number;
  totalActive: number;
  meaningfulWorkPct: number | null;
  avgDds: number | null;
  avgOti: number | null;
  priorWeeklyActive: number;
  priorMeaningfulWorkPct: number | null;
  priorAvgDds: number | null;
  priorAvgOti: number | null;
}

interface CioData {
  vendor: Vendor;
  openaiPresent: boolean;
  adoptionFunnel: FunnelMonth[];
  adoptionHero: HeroFigures & { concentrationPct: number };
  /** The All view's headline figures, split into Claude and OpenAI. */
  heroSplit: { claude: HeroFigures; openai: HeroFigures } | null;
  signalCards: {
    oti: number | null; dds: number | null;
    psr: number | null; ors: number | null;
    orsBreadth?: number | null; orsOverlap?: number | null; orsPropagation?: number | null;
  };
  briefing: { body: string; suggestion: string | null; generated_at: number } | null;
  capabilityLog: Array<{
    id: number; title: string; body: string | null; tier: number | null;
    detected_at: number; confirmed_at: number | null;
    user_id: string; display_name: string | null; email: string; team_id: string | null; department: string | null;
    content_preview: string | null;
  }>;
  coworkCostUsd?: number;
  /** ChatGPT spend from OpenAI's cost records; null until one arrives. */
  chatgptCostUsd?: number | null;
  chatgptUnpricedModels?: string[];
  fileCategoryMix?: Array<{ category: string; count: number; share: number }>;
  weeklyVolume?: {
    series: Array<{ weekStart: number; eventCount: number; tier3Count: number; partial: boolean }>;
    delta: { current: number | null; prior: number | null; pct: number | null };
    tier3Delta: { current: number | null; prior: number | null; pct: number | null };
  };
  delegation?: {
    window: 13 | 26 | 52;
    org: { bands: BandSegment[]; bandsDataWeeks: number; weeks?: Array<{ weekStart: number; t1: number; t2: number; t3: number }> };
    departments: Array<{
      dept: string;
      sparkline: Array<number | null>;
      thenVsNow: PersonDelegation['thenVsNow'];
      dataWeeks: number;
    }>;
    building: Array<{ dept: string; dataWeeks: number }>;
  };
  actNext?: ActNextItem[];
  deptProcesses?: DeptProcessBoxItem[];
  deptRealWork?: Array<{ dept: string; share: number; tasks: number }>;
  realWorkFloorPct?: number | null;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function briefingAge(ts: number): string {
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days === 0) return 'Generated today';
  if (days === 1) return 'Generated yesterday';
  return `Generated ${days} days ago`;
}

export default function CioPulsePage() {
  const [data, setData] = useState<CioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [orgSummary, setOrgSummary] = useState<OrgSummarySlice | null>(null);
  const [orgFull, setOrgFull] = useState<PulseOrgSummary | null>(null);
  const [delegationWeeks, setDelegationWeeks] = useState<13 | 26 | 52>(13);
  // The All / Claude / OpenAI switch, shared with the dashboard.
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/cio?weeks=${delegationWeeks}&vendor=${vendor}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshKey, delegationWeeks, vendor, vendorReady]);

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/org-summary?vendor=${vendor}&window=quarter`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOrgFull(d); if (d) setOrgSummary({ topSkills: d.topSkills ?? [], topConnectors: d.topConnectors ?? [], topNativeTools: d.topNativeTools ?? [], docSessions: d.docSessions, workMix: d.workMix ?? [], sessionOutput: d.sessionOutput ?? null, byProduct: d.byProduct ?? null, humanTime: d.humanTime ?? null }); })
      .catch(() => {});
  }, [refreshKey, vendor, vendorReady]);


  if (loading) return (
    <>
      <TopBar title="Work Pulse: Executive View" subtitle="How deeply people are handing work to AI, what it produces, and where to act" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title="Work Pulse: Executive View" subtitle="How deeply people are handing work to AI, what it produces, and where to act" />
      <PageBody><Notice tone="error" title="Couldn’t load this page.">{error}</Notice></PageBody>
    </>
  );

  if (!data) return null;

  const product = vendor === 'openai' ? 'ChatGPT' : vendor === 'claude' || !data.openaiPresent ? 'Claude' : 'Claude and ChatGPT';
  const briefingText = data.briefing
    ? [data.briefing.body, data.briefing.suggestion ? `\nRecommendation: ${data.briefing.suggestion}` : ''].join('')
    : '';

  return (
    <>
      <TopBar title="Work Pulse" subtitle="Are people handing Claude real work, what does it produce, and where to act" />
      <PageBody className="dash-compact">
        <Toolbar left="Each panel says its own period">
          <span className="flex flex-wrap items-center justify-end gap-3">
            <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={data.openaiPresent} labels={WORK_PULSE_VENDOR_LABELS} />
            <Link href="/admin/pulse" className={B.secondary}>Pulse settings</Link>
          </span>
        </Toolbar>
        {vendor !== 'all' && !openaiOnly && (
          <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">
            Showing {WORK_PULSE_VENDOR_LABELS[vendor]} only{vendor === 'openai' ? ': ChatGPT Chat and ChatGPT Work' : ': Claude Chat, Claude Cowork and Claude in Office/Google'}.
          </p>
        )}

        {/* 1. What the signals are telling you */}
        {orgFull && <WorkPulsePanel data={orgFull} product={product} title="What the signals are telling you" actions />}

        {/* 2. Use cases to act on next */}
        <UseCasesNext boxes={data.deptProcesses ?? []} items={data.actNext ?? []} />

        {/* 3. Are people handing Claude bigger jobs? */}
        <BiggerJobs
          weeks={data.delegation?.org.weeks ?? []}
          departments={data.delegation?.departments ?? []}
          product={product}
          window={delegationWeeks}
          onWindow={setDelegationWeeks}
        />

        {/* 4 and 5 */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <DeptRealWork rows={data.deptRealWork ?? []} floorPct={data.realWorkFloorPct ?? null} />
          <Produced output={orgSummary?.sessionOutput} human={orgSummary?.humanTime} />
        </div>

        {/* 6 and 7 */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Products data={orgSummary?.byProduct} />
          <NewWaysOfWorking confirmedTotal={data.signalCards.psr} confirmedRecent={orgFull?.dashboard?.capabilitiesRecent ?? 0} />
        </div>

        {/* 8. Monthly briefing */}
        <Panel
          title="Monthly briefing"
          badge={<Tag tone="neutral">AI summary</Tag>}
          right={
            <>
              {data.briefing && (
                <span className="text-[13px] text-[#8F8F8F]">{briefingAge(data.briefing.generated_at)} · {formatDate(data.briefing.generated_at)}</span>
              )}
              {data.briefing && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(briefingText).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className={B.secondary}
                  title="Copy briefing to clipboard"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
              <GenerateBriefingButton type="cio" onComplete={() => setRefreshKey(k => k + 1)} />
            </>
          }
        >
          {data.briefing ? (
            <div className="flex flex-col gap-3">
              <div className="lg:columns-2 lg:gap-8">
                {data.briefing.body.split('\n\n').filter(p => p.trim()).map((p, i) => (
                  <p key={i} className="m-0 mb-3 last:mb-0 text-[14px] text-[#333333] leading-6 break-inside-avoid-column">{p}</p>
                ))}
              </div>
              {data.briefing.suggestion && (
                <Notice tone="info" title="Recommendation.">{data.briefing.suggestion}</Notice>
              )}
            </div>
          ) : (
            <Muted>No briefing yet. Use Generate now, or wait for the scheduled run on the 1st of the month.</Muted>
          )}
        </Panel>

        {/* Every confirmed new way of working, one click away */}
        <details id="capability-log" className="group">
          <summary className="cursor-pointer list-none text-[13px] font-medium text-[#245BF3] hover:underline">All confirmed new ways of working</summary>
          <div className="mt-3"><CapabilityLog events={data.capabilityLog} /></div>
        </details>
      </PageBody>
    </>
  );
}

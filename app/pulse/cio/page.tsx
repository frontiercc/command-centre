// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import ByProductPanel, { type ByProductData } from '@/components/pulse/ByProductPanel';
import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Link from 'next/link';
import CapabilityLog from '@/components/pulse/CapabilityLog';
import ValueOnTheTable from '@/components/pulse/ValueOnTheTable';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import DeptTable, { DeptRow } from '@/components/pulse/DeptTable';
import type { FunnelMonth } from '@/components/pulse/AdoptionFunnel';
import OrsBreakdown from '@/components/pulse/OrsBreakdown';
import DelegationBands, { type BandSegment, type PersonDelegation } from '@/components/pulse/DelegationBands';
import { MIN_CHART_DATA_WEEKS } from '@/lib/pulse/delegation';
import ActNextPanel, { type ActNextItem, type DeptProcessBoxItem } from '@/components/pulse/ActNextPanel';
import { PageBody, Toolbar, Panel, BarRow, Tag, Muted, Notice, B } from '@/components/precision/ui';
import SessionOutputCard, { type SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { useVendor, useOpenAiOnly, VendorSwitch, formatSplit } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';
import { BiggerJobs, KnowHow, Produced, Products, DeptCompare, Capabilities, actNextAnswer, type TierWeek } from '@/components/pulse/WorkPulseAnswers';
import { workProductName } from '@/components/dashboard/ThisWeek';

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

function formatTaskType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatSkillName(name: string): string {
  return name.replace(':', ' · ');
}

function formatConnectorName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/_/g, ' ');
}

function InvocationList({ title, items, nameKey, emptyMessage, formatName, showVendor }: {
  title: string;
  items: Array<{ usage_count: number; user_count: number; vendor?: RowVendor; tag?: string; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
  showVendor: boolean;
}) {
  return (
    <Panel title={title} subtitle="30 days" flush={items.length > 0}>
      {items.length === 0 ? (
        <Muted>{emptyMessage}</Muted>
      ) : (
        items.map((item, i) => {
          const name = item[nameKey] as string;
          const maxUsage = items[0].usage_count;
          return (
            <BarRow
              key={`${name}|${item.tag ?? item.vendor ?? ''}`}
              rank={i + 1}
              label={showVendor && item.vendor ? (
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{formatName(name)}</span>
                  <Tag tone="neutral">{item.tag ?? WORK_PULSE_VENDOR_LABELS[item.vendor]}</Tag>
                </span>
              ) : formatName(name)}
              value={`${item.usage_count}× · ${item.user_count} ${item.user_count === 1 ? 'user' : 'users'}`}
              pct={Math.round((item.usage_count / maxUsage) * 100)}
              tone="measured"
            />
          );
        })
      )}
    </Panel>
  );
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
    org: { bands: BandSegment[]; bandsDataWeeks: number; weeks?: TierWeek[] };
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
  tier3ByPerson?: number[];
  tier3People?: number;
  capabilitiesPending?: number;
  capabilityTimeline?: Array<{ id: number; title: string; status: 'confirmed' | 'candidate'; at: number }>;
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
  const [floor, setFloor] = useState(1.5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [orgSummary, setOrgSummary] = useState<OrgSummarySlice | null>(null);
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
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(c => { const f = parseFloat(String(c?.ddsSupportFloor)); if (!isNaN(f)) setFloor(f); })
      .catch(() => {});
    fetch(`/api/pulse/org-summary?vendor=${vendor}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOrgSummary({ topSkills: d.topSkills ?? [], topConnectors: d.topConnectors ?? [], topNativeTools: d.topNativeTools ?? [], docSessions: d.docSessions, workMix: d.workMix ?? [], sessionOutput: d.sessionOutput ?? null, byProduct: d.byProduct ?? null, humanTime: d.humanTime ?? null }); })
      .catch(() => {});
  }, [refreshKey, vendor, vendorReady]);

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/depts?vendor=${vendor}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => setDepts(d.depts ?? []))
      .catch(() => setDepts([]))
      .finally(() => setDeptsLoading(false));
  }, [vendor, vendorReady]);

  if (loading) return (
    <>
      <TopBar title="Work Pulse" subtitle="Are people handing Claude bigger jobs, what does it produce, and where to act" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title="Work Pulse" subtitle="Are people handing Claude bigger jobs, what does it produce, and where to act" />
      <PageBody><Notice tone="error" title="Couldn’t load this page.">{error}</Notice></PageBody>
    </>
  );

  if (!data) return null;

  const product = workProductName(vendor, data.openaiPresent);
  const briefingText = data.briefing
    ? [data.briefing.body, data.briefing.suggestion ? `\nRecommendation: ${data.briefing.suggestion}` : ''].join('')
    : '';
  const act = data.actNext ?? [];
  const boxes = data.deptProcesses ?? [];
  const actAnswer = actNextAnswer(
    boxes.reduce((n, b) => n + b.count, 0),
    act.filter(a => a.type === 'coaching').length,
    act.filter(a => a.type === 'model_review').length,
  );

  return (
    <>
      <TopBar title="Work Pulse" subtitle="Are people handing Claude bigger jobs, what does it produce, and where to act" />
      <PageBody>
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

        {(act.length > 0 || boxes.length > 0) && (
          <ActNextPanel items={act} deptBoxes={boxes} fromBothVendors={data.openaiPresent === true} answer={actAnswer} />
        )}

        <BiggerJobs
          weeks={data.delegation?.org.weeks ?? []}
          departments={data.delegation?.departments ?? []}
          product={product}
          window={delegationWeeks}
          onWindow={setDelegationWeeks}
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <KnowHow counts={data.tier3ByPerson ?? []} people={data.tier3People ?? 0} depts={depts} />
          <Produced output={orgSummary?.sessionOutput} human={orgSummary?.humanTime} product={product} />
          <Products data={orgSummary?.byProduct} />
          {!deptsLoading && <DeptCompare depts={depts} floor={floor} />}
        </div>

        <Capabilities timeline={data.capabilityTimeline ?? []} pending={data.capabilitiesPending ?? 0} confirmedTotal={data.signalCards.psr} />

        {/* The detail, one click away: every figure the answers above are drawn from. */}
        <details id="detail" className="group bg-white border border-[#EAEAEA] rounded-[14px]">
          <summary className="cursor-pointer list-none px-5 py-3.5 text-[14px] font-semibold text-[#0A0A0A] flex items-center gap-2">
            <span className="inline-block transition-transform group-open:rotate-90">›</span> The detail behind these answers
            <span className="ml-auto text-[13px] font-normal text-[#8F8F8F] hidden md:inline">Products, departments over time, kinds of work, tools, capabilities and the monthly briefing</span>
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-4">
            <div id="detail-products"><ByProductPanel data={orgSummary?.byProduct} /></div>

            {data.delegation && (data.delegation.org.bandsDataWeeks > 0 || data.delegation.departments.length > 0 || data.delegation.building.length > 0) && (
              <div id="detail-delegation">
                <DelegationBands
                  title="Depth of work over time"
                  subtitle="Weekly mix of routine, meaningful and frontier work, AI-judged"
                  rowsHeading="Departments, then and now (share of work that was meaningful or frontier)"
                  bands={data.delegation.org.bands}
                  bandsDataWeeks={data.delegation.org.bandsDataWeeks}
                  people={data.delegation.departments.map(d => ({
                    userId: d.dept,
                    displayName: d.dept,
                    sparkline: d.sparkline,
                    thenVsNow: d.thenVsNow,
                    dataWeeks: d.dataWeeks,
                  }))}
                  buildingNote={data.delegation.building.length > 0
                    ? `Still building history: ${data.delegation.building.map(b => `${b.dept} (${b.dataWeeks} weeks)`).join(', ')}. Departments appear at ${MIN_CHART_DATA_WEEKS} weeks of data.`
                    : undefined}
                  window={data.delegation.window}
                  onWindowChange={setDelegationWeeks}
                />
              </div>
            )}

            <div id="detail-output" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {orgSummary?.sessionOutput && <SessionOutputCard report={orgSummary.sessionOutput} />}
              <HumanTimeCard summary={orgSummary?.humanTime} surface="cowork" scope="Organisation, 30 days" view={data.openaiPresent ? vendor : 'claude'} />
            </div>

            {orgSummary && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(orgSummary.workMix ?? []).length > 0 && (
                  <Panel title="Kinds of work" subtitle="30 days" right={<Tag tone="judged">AI-judged</Tag>} flush>
                    {(orgSummary.workMix ?? []).map(w => {
                      const max = (orgSummary.workMix ?? [])[0].messages;
                      return (
                        <BarRow
                          key={w.task_type}
                          label={vendor === 'all' && data.openaiPresent && w.claude !== undefined && w.openai !== undefined ? (
                            <span className="flex flex-col min-w-0">
                              <span className="truncate">{formatTaskType(w.task_type)}</span>
                              <span className="text-[12px] text-[#8F8F8F]">{formatSplit({ claude: w.claude, openai: w.openai }, 'ChatGPT')}</span>
                            </span>
                          ) : formatTaskType(w.task_type)}
                          value={`${w.messages} prompt${w.messages === 1 ? '' : 's'}${w.tier3 > 0 ? ` · ${w.tier3} frontier` : ''}`}
                          pct={(w.messages / max) * 100}
                          tone="judged"
                        />
                      );
                    })}
                  </Panel>
                )}
                <InvocationList
                  title="Top skills"
                  items={orgSummary.topSkills}
                  nameKey="skill_name"
                  emptyMessage="No skills used in the last 30 days."
                  formatName={formatSkillName}
                  showVendor={data.openaiPresent && vendor === 'all'}
                />
                <InvocationList
                  title="Top connectors"
                  items={orgSummary.topConnectors}
                  nameKey="mcp_server"
                  emptyMessage="No connectors used in the last 30 days."
                  formatName={formatConnectorName}
                  showVendor={data.openaiPresent && vendor === 'all'}
                />
              </div>
            )}

            <div id="detail-departments" className="flex flex-col gap-4">
              {deptsLoading ? <Panel title="Departments"><Muted>Loading…</Muted></Panel> : <DeptTable depts={depts} />}
              <OrsBreakdown
                breadth={data.signalCards.orsBreadth ?? null}
                overlap={data.signalCards.orsOverlap ?? null}
                propagation={data.signalCards.orsPropagation ?? null}
              />
            </div>

            <div id="detail-capabilities" className="flex flex-col gap-4">
              <CapabilityLog events={data.capabilityLog} />
              <ValueOnTheTable />
            </div>

            <Panel
              title="Monthly briefing"
              badge={<Tag tone="judged">AI summary</Tag>}
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
          </div>
        </details>
      </PageBody>
    </>
  );
}

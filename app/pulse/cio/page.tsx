// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Link from 'next/link';
import CapabilityLog from '@/components/pulse/CapabilityLog';
import ValueOnTheTable from '@/components/pulse/ValueOnTheTable';
import DeptBenchmark from '@/components/pulse/DeptBenchmark';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import DeptTable, { DeptRow } from '@/components/pulse/DeptTable';
import AdoptionFunnel, { FunnelMonth } from '@/components/pulse/AdoptionFunnel';
import RadarSignals from '@/components/pulse/RadarSignals';
import OrsBreakdown from '@/components/pulse/OrsBreakdown';
import { readOrs as readOrsShared } from '@/lib/pulse/metrics/ors-status';
import Sparkline from '@/components/pulse/Sparkline';
import WeeklyDeltaBadge from '@/components/pulse/WeeklyDeltaBadge';
import DelegationBands, { type BandSegment, type PersonDelegation } from '@/components/pulse/DelegationBands';
import { MIN_CHART_DATA_WEEKS } from '@/lib/pulse/delegation';
import ActNextPanel, { type ActNextItem, type DeptProcessBoxItem } from '@/components/pulse/ActNextPanel';
import { PageBody, Toolbar, Panel, Strip, Figure, BarRow, Tag, Dot, Muted, Notice, B, deltaTone, type Tone } from '@/components/precision/ui';
import SessionOutputCard, { type SessionOutputReport } from '@/components/pulse/SessionOutputCard';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';

interface WorkMixItem {
  task_type: string;
  messages: number;
  tier3: number;
  tier2: number;
  tier1: number;
}

interface OrgSummarySlice {
  topSkills: Array<{ skill_name: string; usage_count: number; user_count: number }>;
  topConnectors: Array<{ mcp_server: string; usage_count: number; user_count: number }>;
  topNativeTools?: Array<{ tool_name: string; usage_count: number; user_count: number }>;
  docSessions?: { sessions_with_uploads: number; total_uploads: number };
  workMix?: WorkMixItem[];
  sessionOutput?: SessionOutputReport | null;
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

function InvocationList({ title, items, nameKey, emptyMessage, formatName }: {
  title: string;
  items: Array<{ usage_count: number; user_count: number; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
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
              key={name}
              rank={i + 1}
              label={formatName(name)}
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

interface CioData {
  adoptionFunnel: FunnelMonth[];
  adoptionHero: {
    weeklyActive: number;
    totalActive: number;
    meaningfulWorkPct: number;
    avgDds: number | null;
    avgOti: number | null;
    concentrationPct: number;
    priorWeeklyActive: number;
    priorMeaningfulWorkPct: number | null;
    priorAvgDds: number | null;
    priorAvgOti: number | null;
  };
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
  fileCategoryMix?: Array<{ category: string; count: number; share: number }>;
  weeklyVolume?: {
    series: Array<{ weekStart: number; eventCount: number; tier3Count: number; partial: boolean }>;
    delta: { current: number | null; prior: number | null; pct: number | null };
    tier3Delta: { current: number | null; prior: number | null; pct: number | null };
  };
  delegation?: {
    window: 13 | 26 | 52;
    org: { bands: BandSegment[]; bandsDataWeeks: number };
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
}

function WeeklyVolumeCard({ data }: { data: CioData['weeklyVolume'] }) {
  if (!data) return null;
  const lastPartial = data.series[data.series.length - 1]?.partial ?? false;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Panel title="Classified work volume" subtitle="8 weeks, across the organisation">
        <Sparkline data={data.series.map(w => w.eventCount)} partialLast={lastPartial} height={64} label="Classified work volume" />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[13px] text-[#8F8F8F]">Week to date shown hollow</span>
          <WeeklyDeltaBadge pct={data.delta.pct} />
        </div>
      </Panel>
      <Panel title="Frontier work volume" subtitle="Tier 3 work per week, 8 weeks" right={<Tag tone="judged">AI-judged</Tag>}>
        <Sparkline data={data.series.map(w => w.tier3Count)} partialLast={lastPartial} height={64} estimate label="Frontier work volume" />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[13px] text-[#8F8F8F]">Week to date shown hollow</span>
          <WeeklyDeltaBadge pct={data.tier3Delta?.pct ?? null} />
        </div>
      </Panel>
    </div>
  );
}

function herodelta(current: number | null, prior: number | null, suffix = ''): string | null {
  if (current === null || prior === null) return null;
  const diff = current - prior;
  if (Math.abs(diff) < 0.005) return null;
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  const formatted = Number.isInteger(abs) ? String(Math.round(abs)) : abs.toFixed(2);
  return `${sign}${formatted}${suffix} on last period`;
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

interface GovernanceHealth {
  governanceScore: number;
  components: {
    queue_review_latency: { median_hours: number | null; score: number | null; actioned_in_window: number };
    alert_acknowledgment: { rate: number | null; total_alerts: number; resolved_alerts: number };
    queue_health: { pending_now: number; score: number };
    reviewer_spread: { distinct_reviewers: number; score: number | null };
  };
  thresholds: { warning: number; critical: number };
}

// ── Plain-language signal interpretations ─────────────────────────────────────

interface SignalRead {
  question: string;
  status: string;
  plain: string;
  why: string | null;
  statusColor: string;
  dotColor: string;
}

function readOti(oti: number | null, prior: number | null): SignalRead {
  const question = 'Is the team producing more valuable work with the same time?';
  const why = prior !== null && oti !== null
    ? oti > prior
      ? `Up from ${prior.toFixed(2)}× last period. Output quality is improving.`
      : oti < prior
        ? `Down from ${prior.toFixed(2)}× last period. Worth reviewing what has changed.`
        : null
    : null;
  if (oti === null) return { question, status: 'Not yet measurable', plain: 'Requires at least two comparable periods. Will appear once the team has a baseline and recent classified activity.', why: null, statusColor: 'text-gray-400', dotColor: 'bg-gray-300' };
  const pct = Math.round((oti - 1) * 100);
  if (oti >= 1.5) return { question, status: 'Significant uplift', plain: `Output is ${pct}% more valuable than your starting baseline. The quality and consequence of work has fundamentally changed, not just speed.`, why, statusColor: 'text-emerald-600', dotColor: 'bg-emerald-500' };
  if (oti >= 1.2) return { question, status: 'Meaningful progress', plain: `Output quality is ${pct}% above your starting baseline. The trajectory is positive: delegation is producing more valuable work, not just the same work faster.`, why, statusColor: 'text-emerald-600', dotColor: 'bg-emerald-500' };
  if (oti >= 1.0) return { question, status: 'Marginal improvement', plain: `Slightly above baseline. The tool is active but the quality of output has not shifted significantly yet. The operating model has not changed.`, why, statusColor: 'text-amber-500', dotColor: 'bg-amber-400' };
  return { question, status: 'Below baseline', plain: `Output quality has declined from your starting point. The team may be delegating work that does not benefit from AI at this depth.`, why, statusColor: 'text-red-500', dotColor: 'bg-red-400' };
}

function readDds(dds: number | null, prior: number | null): SignalRead {
  const question = 'Is the team using AI for simple tasks, or fundamentally changing how work gets done?';
  const why = prior !== null && dds !== null
    ? dds > prior
      ? `Up from ${prior.toFixed(2)} last period. The team is going deeper.`
      : dds < prior
        ? `Down from ${prior.toFixed(2)} last period. Delegation complexity has dropped.`
        : null
    : null;
  if (dds === null) return { question, status: 'Not yet measurable', plain: 'Requires 14 days of classified Cowork sessions.', why: null, statusColor: 'text-gray-400', dotColor: 'bg-gray-300' };
  if (dds >= 2.0) return { question, status: 'Frontier depth', plain: `Team is operating at the frontier: work that genuinely extends human capability. This is not task automation. It is a structurally different operating model.`, why, statusColor: 'text-emerald-600', dotColor: 'bg-emerald-500' };
  if (dds >= 1.5) return { question, status: 'Meaningful depth', plain: `Delegation is going beyond routine tasks. The operating model is beginning to shift: not just productivity, but how work gets structured and who does what.`, why, statusColor: 'text-blue-500', dotColor: 'bg-blue-400' };
  return { question, status: 'Surface use', plain: `AI is being used for simple tasks. The most common pattern in enterprise deployment. The tool is active but the operating model has not changed, and this is invisible to every other measurement approach.`, why, statusColor: 'text-amber-500', dotColor: 'bg-amber-400' };
}

function readCapabilitiesCreated(count: number | null): SignalRead {
  const question = 'How many new types of work has the team handed to Claude?';
  if (count === null) return { question, status: 'None confirmed yet', plain: 'Capability candidates appear automatically when Claude handles a new type of task. Review and confirm them to start tracking.', why: null, statusColor: 'text-gray-400', dotColor: 'bg-gray-300' };
  if (count === 0) return { question, status: 'None confirmed yet', plain: 'Candidates detected. Confirm them in the capability queue to start counting.', why: null, statusColor: 'text-gray-400', dotColor: 'bg-gray-300' };
  return { question, status: `${count} ${count === 1 ? 'capability' : 'capabilities'} created`, plain: `The team has confirmed ${count} distinct types of work now handled by Claude. Each confirmed capability represents a repeatable shift in how work gets done.`, why: null, statusColor: 'text-emerald-600', dotColor: 'bg-emerald-500' };
}

function readOrs(ors: number | null): SignalRead {
  const question = 'Would this capability survive if the best AI person on the team left tomorrow?';
  const shared = readOrsShared(ors);
  return { question, status: shared.status, plain: shared.plain, why: null, statusColor: shared.statusColor, dotColor: shared.dotColor };
}

// ── Signal cell: one of four in "What the signals are telling you" ──────────

const STATUS_DOT: Record<string, string> = {
  'bg-emerald-500': '#1A7F37', 'bg-blue-400': '#245BF3', 'bg-amber-400': '#DC8A00',
  'bg-red-400': '#D92D20', 'bg-gray-300': '#A3A3A3',
};

function SignalCell({ name, read, first }: { name: string; read: SignalRead; first: boolean }) {
  const color = STATUS_DOT[read.dotColor] ?? '#A3A3A3';
  return (
    <div className={`p-4 flex flex-col gap-2 min-w-0 ${first ? '' : 'border-t md:border-t-0 md:border-l border-[#EAEAEA]'}`}>
      <span className="text-[13px] text-[#8F8F8F]">{name}</span>
      <span className="text-[14px] font-semibold text-[#0A0A0A] leading-5">{read.question}</span>
      <Dot color={color}><span className="font-medium" style={{ color: color === '#A3A3A3' ? '#666666' : color }}>{read.status}</span></Dot>
      <p className="m-0 text-[14px] text-[#4D4D4D] leading-5">{read.plain}</p>
      {read.why && <p className="m-0 text-[13px] text-[#8F8F8F] pt-2 border-t border-[#F2F2F2]">{read.why}</p>}
    </div>
  );
}

function heroTone(current: number | null, prior: number | null): Tone {
  if (current === null || prior === null) return 'neutral';
  return deltaTone(current - prior);
}

export default function CioPulsePage() {
  const [data, setData] = useState<CioData | null>(null);
  const [govHealth, setGovHealth] = useState<GovernanceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [orgSummary, setOrgSummary] = useState<OrgSummarySlice | null>(null);
  const [delegationWeeks, setDelegationWeeks] = useState<13 | 26 | 52>(13);

  useEffect(() => {
    fetch(`/api/pulse/cio?weeks=${delegationWeeks}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshKey, delegationWeeks]);

  useEffect(() => {
    fetch('/api/pulse/governance-health')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setGovHealth(d); })
      .catch(() => {});
    fetch('/api/pulse/org-summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOrgSummary({ topSkills: d.topSkills ?? [], topConnectors: d.topConnectors ?? [], topNativeTools: d.topNativeTools ?? [], docSessions: d.docSessions, workMix: d.workMix ?? [], sessionOutput: d.sessionOutput ?? null, humanTime: d.humanTime ?? null }); })
      .catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    fetch('/api/pulse/depts')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => setDepts(d.depts ?? []))
      .catch(() => setDepts([]))
      .finally(() => setDeptsLoading(false));
  }, []);

  if (loading) return (
    <>
      <TopBar title="Work Pulse: Executive View" subtitle="How deeply people are handing work to Claude, what it produces, and where to act" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title="Work Pulse: Executive View" subtitle="How deeply people are handing work to Claude, what it produces, and where to act" />
      <PageBody><Notice tone="error" title="Couldn’t load this page.">{error}</Notice></PageBody>
    </>
  );

  if (!data) return null;

  const h = data.adoptionHero;
  const briefingText = data.briefing
    ? [data.briefing.body, data.briefing.suggestion ? `\nRecommendation: ${data.briefing.suggestion}` : ''].join('')
    : '';

  return (
    <>
      <TopBar title="Work Pulse: Executive View" subtitle="How deeply people are handing work to Claude, what it produces, and where to act" />
      <PageBody>
        <Toolbar left="Last 14 days unless a panel says otherwise">
          <Link href="/admin/pulse" className={B.secondary}>Pulse settings</Link>
        </Toolbar>

        {/* Headline figures */}
        <Strip cols={5}>
          <Figure
            label="Using Cowork weekly"
            value={String(h.weeklyActive)}
            unit="people"
            delta={herodelta(h.weeklyActive, h.priorWeeklyActive)}
            deltaTone={heroTone(h.weeklyActive, h.priorWeeklyActive)}
          />
          <Figure
            label="Meaningful work"
            value={`${h.meaningfulWorkPct}%`}
            tone="judged"
            sub="of work at Tier 2 or 3"
            delta={herodelta(h.meaningfulWorkPct, h.priorMeaningfulWorkPct, '%')}
            deltaTone={heroTone(h.meaningfulWorkPct, h.priorMeaningfulWorkPct)}
          />
          <Figure
            label="More valuable work"
            value={h.avgOti !== null ? `${h.avgOti.toFixed(2)}×` : '—'}
            tone="judged"
            sub="output against baseline"
            delta={herodelta(h.avgOti, h.priorAvgOti, '×')}
            deltaTone={heroTone(h.avgOti, h.priorAvgOti)}
          />
          <Figure
            label="Delegation depth"
            value={h.avgDds !== null ? h.avgDds.toFixed(2) : '—'}
            tone="judged"
            sub="average, 14 days"
            delta={herodelta(h.avgDds, h.priorAvgDds)}
            deltaTone={heroTone(h.avgDds, h.priorAvgDds)}
          />
          <Figure
            label="Concentration"
            value={`${h.concentrationPct}%`}
            sub="of Tier 3 work on 3 people"
          />
        </Strip>

        <WeeklyVolumeCard data={data.weeklyVolume} />

        {/* What to act on next: dept process boxes + coaching rows */}
        {((data.actNext?.length ?? 0) > 0 || (data.deptProcesses?.length ?? 0) > 0) && (
          <ActNextPanel items={data.actNext ?? []} deptBoxes={data.deptProcesses ?? []} />
        )}

        {/* Delegation over time: org bands + dept then-vs-now rows (AI-judged) */}
        {data.delegation && (data.delegation.org.bandsDataWeeks > 0 || data.delegation.departments.length > 0 || data.delegation.building.length > 0) && (
          <DelegationBands
            title="Delegation over time"
            subtitle="Weekly tier mix across everyone, AI-judged"
            rowsHeading="Departments, then vs now (share of work at Tier 2 or above)"
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
              ? `Building history: ${data.delegation.building.map(b => `${b.dept} (${b.dataWeeks}w)`).join(' · ')}. Departments appear at ${MIN_CHART_DATA_WEEKS} weeks of data.`
              : undefined}
            window={data.delegation.window}
            onWindowChange={setDelegationWeeks}
          />
        )}

        {/* Briefing full width, its text in two columns so lines stay readable; spend and documents
            in a row beneath (beside a long briefing they left a tall empty gap). */}
        <div className="flex flex-col gap-4">
          <Panel
            title="Intelligence briefing"
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
              <Muted>No briefing generated yet. Use Generate now, or wait for the scheduled run on the 1st of the month.</Muted>
            )}
          </Panel>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.coworkCostUsd !== undefined && (
              <Panel title="Cowork spend" subtitle="7 days">
                <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#0A0A0A]">
                  {data.coworkCostUsd === 0
                    ? <span className="text-[#8F8F8F]">$0.00</span>
                    : data.coworkCostUsd >= 100
                      ? `$${data.coworkCostUsd.toFixed(0)}`
                      : `$${data.coworkCostUsd.toFixed(2)}`}
                </p>
                <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">API cost of every Cowork session, measured</p>
              </Panel>
            )}
            {orgSummary?.docSessions && orgSummary.docSessions.sessions_with_uploads > 0 && (
              <Panel title="Document sessions" subtitle="30 days" right={<Link href="/admin/files" className={B.link}>View files</Link>}>
                <div className="flex items-baseline gap-4 flex-wrap">
                  <span><span className="text-[24px] leading-7 font-semibold tabular-nums">{orgSummary.docSessions.sessions_with_uploads}</span> <span className="text-[13px] text-[#8F8F8F]">sessions with uploads</span></span>
                  <span><span className="text-[18px] font-semibold tabular-nums text-[#4D4D4D]">{orgSummary.docSessions.total_uploads}</span> <span className="text-[13px] text-[#8F8F8F]">files uploaded</span></span>
                </div>
              </Panel>
            )}
          </div>
        </div>

        {/* Human time vs Claude time */}
        <HumanTimeCard summary={orgSummary?.humanTime} surface="cowork" scope="Organisation, 30 days" />

        {/* Top skills, top connectors, produced a file, work mix */}
        {orgSummary && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <InvocationList
              title="Top skills"
              items={orgSummary.topSkills}
              nameKey="skill_name"
              emptyMessage="No skill invocations captured yet."
              formatName={formatSkillName}
            />
            <InvocationList
              title="Top connectors"
              items={orgSummary.topConnectors}
              nameKey="mcp_server"
              emptyMessage="No connector invocations captured yet."
              formatName={formatConnectorName}
            />
            {orgSummary.sessionOutput && <SessionOutputCard report={orgSummary.sessionOutput} />}
            {(orgSummary.workMix ?? []).length > 0 && (
              <Panel title="Work mix" subtitle="30 days" right={<Tag tone="judged">AI-judged</Tag>} flush>
                {(orgSummary.workMix ?? []).map(w => {
                  const max = (orgSummary.workMix ?? [])[0].messages;
                  return (
                    <BarRow
                      key={w.task_type}
                      label={formatTaskType(w.task_type)}
                      value={`${w.messages} msg${w.messages === 1 ? '' : 's'}${w.tier3 > 0 ? ` · ${w.tier3} frontier` : ''}`}
                      pct={(w.messages / max) * 100}
                      tone="judged"
                    />
                  );
                })}
              </Panel>
            )}
          </div>
        )}

        {/* What the signals are telling you */}
        <Panel title="What the signals are telling you" flush>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
            <SignalCell first name="Output quality" read={readOti(data.signalCards.oti, data.adoptionHero.priorAvgOti)} />
            <SignalCell first={false} name="Delegation depth" read={readDds(data.signalCards.dds, data.adoptionHero.priorAvgDds)} />
            <SignalCell first={false} name="Capabilities created" read={readCapabilitiesCreated(data.signalCards.psr)} />
            <SignalCell first={false} name="Resilience" read={readOrs(data.signalCards.ors)} />
          </div>
        </Panel>

        <OrsBreakdown
          breadth={data.signalCards.orsBreadth ?? null}
          overlap={data.signalCards.orsOverlap ?? null}
          propagation={data.signalCards.orsPropagation ?? null}
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <RadarSignals
            oti={data.signalCards.oti}
            dds={data.signalCards.dds}
            governanceScore={govHealth?.governanceScore ?? null}
            ors={data.signalCards.ors}
          />
          <AdoptionFunnel data={data.adoptionFunnel ?? []} />
        </div>

        {/* Departments */}
        {deptsLoading ? (
          <Panel title="Departments"><Muted>Loading…</Muted></Panel>
        ) : (
          <>
            <DeptTable depts={depts} />
            {/* Even-adoption spread, support framing (not a league table) */}
            <DeptBenchmark depts={depts} />
          </>
        )}

        <CapabilityLog events={data.capabilityLog} />

        {/* Value on the table: manager-attributed capability value */}
        <ValueOnTheTable />
      </PageBody>
    </>
  );
}

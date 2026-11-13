// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { type CodeMetricsRow, formatCurrency, formatTokens, FigureGrid } from '@/components/pulse/code/CodeStatStrip';
import CodeProductivityStrip from '@/components/pulse/code/CodeProductivityStrip';
import ModelMixBar, { type ModelMixItem } from '@/components/pulse/code/ModelMixBar';
import RepoCoverageList, { type ActiveRepo, type DarkRepo } from '@/components/pulse/code/RepoCoverageList';
import CodeBriefingCard from '@/components/pulse/code/CodeBriefingCard';
import ShippingAlignmentChart from '@/components/pulse/code/ShippingAlignmentChart';
import GithubRepoCards from '@/components/pulse/code/GithubRepoCards';
import Sparkline from '@/components/pulse/Sparkline';
import WeeklyDeltaBadge from '@/components/pulse/WeeklyDeltaBadge';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { displayDefinition } from '@/lib/pulse/code/work-type-labels';
import { useVendor, useOpenAiOnly, VendorSwitch, formatSplit } from '@/components/shared/VendorSwitch';
import { DEVELOPER_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';
import {
  PageBody, Toolbar, Panel, PanelFoot, SubHead, Figure, BarRow, Bar, Tag, Pill, Notice, Muted,
} from '@/components/precision/ui';

interface WeeklyPoint {
  weekStart: number;
  value: number | null;
  partial: boolean;
}

interface WeeklyTrend {
  series: WeeklyPoint[];
  delta: { current: number | null; prior: number | null; pct: number | null };
}

interface OrgSummary {
  vendor?: Vendor;
  codexPresent?: boolean;
  /** All view, once Codex data exists: Claude Code's and Codex's own figures. */
  metricsSplit?: { claude: CodeMetricsRow | null; openai: CodeMetricsRow | null } | null;
  humanTime?: HumanTimeSummary | null;
  metrics: CodeMetricsRow | null;
  priorMetrics: { spend_usd: number | null; autonomy_ratio: number | null; session_count: number } | null;
  trends: { spend: WeeklyTrend; autonomy: WeeklyTrend; commits: WeeklyTrend; sessions: WeeklyTrend };
  modelMix: ModelMixItem[];
  unpricedModels: string[];
  spendIsPartlyEstimated: boolean;
  activeRepos: ActiveRepo[];
  darkRepos: DarkRepo[];
  topSkills: Array<{ skill_name: string; uses: number; agent_chained: number }>;
  topConnectors: Array<{ mcp_server: string; uses: number }>;
  skillLeverage: Array<{ name: string; turns: number; tokens: number; spend_usd: number | null }>;
  agentLeverage: Array<{ name: string; turns: number; tokens: number; spend_usd: number | null }>;
  subagentShare: number | null;
  spendConcentration: {
    spenderCount: number;
    totalSpend: number;
    tiers: Array<{ topN: number; share: number }>;
  } | null;
  languageMix: Array<{ language: string; edits: number }>;
  highFrictionSessions: Array<{ session_id: string; user_id: string | null; user_display_name: string | null; repo: string | null; error_count: number; tool_use_count: number; last_at: number }>;
  workMix: Array<{ work_type: string; label?: string; definition?: string | null; sessions: number; tier1: number; tier2: number; tier3: number; provisional: number; claude?: number; openai?: number }> | null;
  githubOverlay: {
    trackedRepoCount: number;
    totalCommits7d: number;
    totalPrs7d: number;
    totalCommits30dByRepo: Record<string, number>;
    reposActive7d: number;
    shippingSeries: Array<{ date: string; aiCommits: number; ghCommits: number; ghPrs: number; ghClaude?: number | null; ghCodex?: number | null; ghNone?: number | null }>;
    repoCards: Array<{ repo: string; commits7d: number; commitsPrev7d: number; prs30d: number; commits30d: number; daily: number[] }>;
    toolSplit?: boolean;
    /** Codex tab: tracked repos reached, worked out from GitHub commits matched to Codex. */
    codexReach?: { activeRepos7d: number; quietRepos30d: number; trackedRepos: number } | null;
  } | null;
  spendProjection: { projected: number; daysElapsed: number; daysInMonth: number } | null;
}


// ─── Verdict cards (formerly the Executive View) ─────────────────────────────

interface Verdict {
  question: string;
  value: string;
  status: 'good' | 'building' | 'attention' | 'neutral';
  plain: string;
  trend?: WeeklyTrend;
  /** Violet estimate note shown under the value — used by the spend verdict only. */
  estimateBadge?: string;
  /** Month-end spend projection line (spend verdict only). */
  projection?: string;
  /** All view: the Claude Code and Codex parts under the value. */
  split?: string;
  /** A quiet line under the explanation saying where the figure comes from. */
  note?: string;
}

/** The product names each view uses in its wording. */
function productWords(vendor: Vendor) {
  if (vendor === 'claude') return { tool: 'Claude Code', actor: 'Claude', sessions: 'Claude Code sessions' };
  if (vendor === 'openai') return { tool: 'Codex', actor: 'Codex', sessions: 'Codex sessions' };
  return { tool: 'AI coding', actor: 'The AI', sessions: 'Claude Code and Codex sessions' };
}

const STATUS_TONE: Record<Verdict['status'], 'good' | 'info' | 'warn' | 'neutral'> = {
  good: 'good',
  building: 'info',
  attention: 'warn',
  neutral: 'neutral',
};

const STATUS_LABEL: Record<Verdict['status'], string> = {
  good: 'Healthy',
  building: 'Building',
  attention: 'Worth a look',
  neutral: 'Context',
};

function buildVerdicts(d: OrgSummary, vendor: Vendor): Verdict[] {
  const m = d.metrics;
  const w = productWords(vendor);
  const sp = d.metricsSplit;
  const part = (pick: (r: CodeMetricsRow) => number | null, fmt: (v: number) => string) => {
    if (!sp) return undefined;
    const c = sp.claude ? pick(sp.claude) : null;
    const o = sp.openai ? pick(sp.openai) : null;
    // Shown only when both products have a figure, never as "n/a".
    if (c == null || o == null) return undefined;
    return `Claude Code ${fmt(c)} · Codex ${fmt(o)}`;
  };
  const spendPerSession = m && m.spend_usd !== null && m.session_count > 0 ? m.spend_usd / m.session_count : null;
  // Trend wording comes from the completed-week delta, never a render-time
  // guess against the rolling snapshot — pct is null until two completed
  // weeks of history exist, in which case we omit trend language entirely.
  const spendPct = d.trends?.spend?.delta?.pct ?? null;
  const spendTrend = spendPct == null ? null : spendPct >= 0.20 ? 'rising' : spendPct <= -0.20 ? 'falling' : 'steady';

  const autonomy = m?.autonomy_ratio ?? null;
  const subagentPct = d.subagentShare != null ? Math.round(d.subagentShare * 100) : null;
  const subagentNote = subagentPct != null ? ` ${subagentPct}% of turns were subagent-driven, a measure of delegation depth.` : '';
  const commits = m?.commit_count ?? 0;
  const darkCount = d.darkRepos.length;
  const activeCount = m?.repo_count ?? 0;
  const hasRepoData = activeCount > 0 || darkCount > 0 || (d.activeRepos?.length ?? 0) > 0;

  const verdicts: Verdict[] = [
    {
      question: `What is ${w.tool} costing us?`,
      value: m?.spend_usd == null ? '—' : formatCurrency(m.spend_usd),
      status: 'neutral',
      plain: m?.spend_usd == null
        ? 'No priced activity in the window yet.'
        : `${formatCurrency(m.spend_usd)} this week across ${m.session_count} sessions` +
          (spendPerSession !== null ? ` (${formatCurrency(spendPerSession)} per session)` : '') +
          (spendTrend ? `, ${spendTrend} week-on-week` : '') +
          '. Spend is context, not a verdict: read it alongside autonomy and shipping.',
      trend: d.trends?.spend,
      estimateBadge: d.spendIsPartlyEstimated
        ? 'Includes provider-routed usage estimated at list pricing'
        : undefined,
      projection: d.spendProjection != null
        ? `≈ ${formatCurrency(d.spendProjection.projected)} projected month-end`
        : undefined,
      split: part(r => r.spend_usd, formatCurrency),
    },
    {
      question: 'Are developers delegating, or just typing faster?',
      value: autonomy == null ? '—' : `${autonomy.toFixed(1)}× `,
      status: autonomy == null ? 'neutral' : autonomy >= 3 ? 'good' : autonomy >= 1 ? 'building' : 'attention',
      plain: (autonomy == null
        ? 'No activity to judge yet.'
        : autonomy >= 3
          ? `${w.actor} takes ${autonomy.toFixed(1)} actions per human instruction: developers are supervising delegated work, not dictating keystrokes.`
          : autonomy >= 1
            ? `${w.actor} takes ${autonomy.toFixed(1)} actions per instruction: delegation is forming but still hands-on.`
            : `Under one action per instruction: ${w.actor === 'The AI' ? 'AI' : w.actor} is being used as a conversational aid more than a delegate. Expect this to rise as trust builds.`) + subagentNote,
      trend: d.trends?.autonomy,
      split: part(r => r.autonomy_ratio, v => `${v.toFixed(1)}×`),
    },
    {
      question: 'Is AI-assisted work actually shipping?',
      value: String(commits),
      status: commits > 0 ? 'good' : 'attention',
      plain: (commits > 0
        ? `${commits} AI-assisted commit${commits === 1 ? '' : 's'} from ${w.sessions} this week.`
        : `No AI-assisted commits in ${w.sessions} this week. Activity may be exploration, review, or Q&A rather than shipping.`)
        + (d.githubOverlay
            ? ` Shipping context: the ${d.githubOverlay.trackedRepoCount} tracked repo${d.githubOverlay.trackedRepoCount === 1 ? '' : 's'} saw ${d.githubOverlay.totalCommits7d} commit${d.githubOverlay.totalCommits7d === 1 ? '' : 's'} and ${d.githubOverlay.totalPrs7d} merged PR${d.githubOverlay.totalPrs7d === 1 ? '' : 's'} on GitHub this week.`
            : ' Add repositories in admin to see GitHub shipping volume alongside this.'),
      trend: d.trends?.commits,
      split: part(r => r.commit_count ?? null, v => String(v)),
    },
    {
      question: 'How much of our codebase does this reach?',
      value: `${activeCount} repo${activeCount === 1 ? '' : 's'}`,
      status: darkCount > activeCount ? 'attention' : activeCount > 0 ? 'building' : 'neutral',
      plain: darkCount > 0
        ? `${activeCount} active repo${activeCount === 1 ? '' : 's'} this week; ${darkCount} repo${darkCount === 1 ? ' has' : 's have'} gone quiet for 30+ days. Quiet repos are the expansion opportunity.`
        : `${activeCount} repo${activeCount === 1 ? '' : 's'} with ${w.tool} activity this week and nothing has gone quiet.`,
    },
  ];
  // Codex reports no repository, so on the Codex tab the reach comes from
  // GitHub: tracked repos that received commits matched to Codex.
  const reach = d.githubOverlay?.codexReach ?? null;
  if (vendor === 'openai') {
    const rest = verdicts.filter(v => !v.question.startsWith('How much of our codebase'));
    if (!reach) return rest;
    const a = reach.activeRepos7d;
    const quiet = reach.quietRepos30d;
    return [...rest, {
      question: 'How much of our codebase does this reach?',
      value: `${a} repo${a === 1 ? '' : 's'}`,
      status: quiet > a ? 'attention' : a > 0 ? 'building' : 'neutral',
      plain: `${a} tracked repo${a === 1 ? '' : 's'} received commits made with Codex this week` +
        (quiet > 0
          ? `; ${quiet} of ${reach.trackedRepos} had none in the last 30 days. Quiet repos are the expansion opportunity.`
          : ', and every tracked repo had one in the last 30 days.'),
      note: 'Worked out from GitHub commits matched to Codex, on the GitHub-tracked repos only: Codex does not report which repository it worked in.',
    }];
  }
  // Retire the repo-centric verdict on OTel-only instances (no cwd → no repo data),
  // where it would always read "0 repos". Instances with repo data keep it.
  return hasRepoData ? verdicts : verdicts.filter(v => !v.question.startsWith('How much of our codebase'));
}

function VerdictPanel({ v }: { v: Verdict }) {
  return (
    <Panel title={v.question} right={<Pill tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill>}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-end gap-4">
          <span className="text-[28px] leading-8 font-semibold tracking-[-0.03em] tabular-nums text-[#0A0A0A]">{v.value}</span>
          {v.trend && (
            <div className="ml-auto w-40 shrink-0">
              <Sparkline
                data={v.trend.series.map(p => p.value)}
                partialLast={v.trend.series[v.trend.series.length - 1]?.partial ?? false}
                label={v.question}
              />
            </div>
          )}
        </div>
        {v.split && <p className="m-0 -mt-1 text-[13px] text-[#8F8F8F] tabular-nums">{v.split}</p>}
        {(v.projection || v.estimateBadge) && (
          <div className="flex flex-col gap-0.5 text-[13px] text-[#2451F3]">
            {v.projection && <span title="Last-7-day run rate extended to month end">{v.projection}</span>}
            {v.estimateBadge && <span>{v.estimateBadge}</span>}
          </div>
        )}
        <p className="m-0 text-[14px] leading-[1.5] text-[#4D4D4D]">{v.plain}</p>
        {v.note && <p className="m-0 text-[13px] text-[#8F8F8F]">{v.note}</p>}
        {v.trend && (
          <div className="flex items-center gap-2 flex-wrap text-[13px] text-[#8F8F8F]">
            <span>8-week trend · week to date shown hollow</span>
            <span className="ml-auto"><WeeklyDeltaBadge pct={v.trend.delta.pct} /></span>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function LanguageMixCard({ items }: { items: Array<{ language: string; edits: number }> }) {
  const max = items[0]?.edits ?? 0;
  return (
    <Panel title="Language mix" subtitle="30 days" flush>
      <div className="px-4 pt-3 pb-2">
        <Muted>Edits by language: what the team is actually building in (from edit-decision telemetry).</Muted>
      </div>
      {items.length === 0 ? (
        <div className="px-4 pb-4"><Muted>No edit-decision data yet.</Muted></div>
      ) : (
        <div className="pb-1">
          {items.map(l => (
            <BarRow
              key={l.language}
              label={l.language}
              value={`${l.edits.toLocaleString()} edit${l.edits === 1 ? '' : 's'}`}
              pct={max > 0 ? Math.round((l.edits / max) * 100) : 0}
              tone="measured"
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/**
 * `claude` is Claude Code's own row: pull requests, engaged time, lines and
 * edit decisions come only from Claude Code's telemetry, so those ratios use
 * its spend and tokens, never a total that includes Codex. Null in the Codex view.
 */
function EfficiencyCard({ metrics, claude }: { metrics: CodeMetricsRow | null; claude: CodeMetricsRow | null }) {
  const m = metrics;
  if (!m) return null;
  const commits = m.commit_count ?? 0;
  const costPerCommit = m.spend_usd != null && commits > 0 ? m.spend_usd / commits : null;
  const c = claude;
  const engagedHours = c ? ((c.active_time_user_s ?? 0) + (c.active_time_cli_s ?? 0)) / 3600 : 0;
  const prs = c?.pr_count ?? 0;
  const accepts = c?.edit_accept_count ?? 0;
  const costPerPr = c && c.spend_usd != null && prs > 0 ? c.spend_usd / prs : null;
  const linesPerHour = c && engagedHours > 0 ? Math.round((c.lines_added ?? 0) / engagedHours) : null;
  const tokensPerAccept = c && accepts > 0 ? (c.input_tokens + c.output_tokens) / accepts : null;
  // Nothing to show until the productivity metrics arrive.
  if (costPerCommit == null && costPerPr == null && linesPerHour == null && tokensPerAccept == null) return null;
  const cells = [
    { label: 'Cost per commit', value: costPerCommit == null ? '—' : formatCurrency(costPerCommit) },
    { label: 'Cost per PR', value: costPerPr == null ? '—' : formatCurrency(costPerPr) },
    { label: 'Lines per engaged hour', value: linesPerHour == null ? '—' : linesPerHour.toLocaleString() },
    { label: 'Tokens per accepted edit', value: tokensPerAccept == null ? '—' : formatTokens(Math.round(tokensPerAccept)) },
  ];
  return (
    <Panel title="Efficiency" subtitle="7 days" flush>
      <FigureGrid cols={4}>
        {cells.map(c => <Figure key={c.label} label={c.label} value={c.value} />)}
      </FigureGrid>
    </Panel>
  );
}

function SpendConcentrationCard({ data }: { data: OrgSummary['spendConcentration'] }) {
  if (!data) return null;
  return (
    <Panel title="Spend concentration" subtitle="30 days" flush>
      <div className="px-4 pt-3">
        <Muted>
          Share of total Code spend held by the top spenders, across {data.spenderCount} active users: a key-person and
          automation-runaway signal, not a verdict.
        </Muted>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4">
        {data.tiers.map(t => {
          const pct = Math.round(t.share * 100);
          return (
            <div key={t.topN} className="flex flex-col gap-1.5">
              <span className="text-[13px] text-[#666666]">Top {t.topN}</span>
              <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#0A0A0A]">{pct}%</span>
              <Bar pct={pct} tone="measured" height={4} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function leverageValue(item: { turns: number; spend_usd: number | null }): string {
  const costPerUse = item.spend_usd != null && item.turns > 0 ? item.spend_usd / item.turns : null;
  const costPerUseDisplay = costPerUse != null
    ? costPerUse < 0.005 ? '<$0.01/use' : `$${costPerUse.toFixed(2)}/use`
    : null;
  return `${item.spend_usd == null ? 'unpriced' : formatCurrency(item.spend_usd)} · ${item.turns}×${costPerUseDisplay ? ` · ${costPerUseDisplay}` : ''}`;
}

function LeverageRow({ item, max }: { item: { name: string; turns: number; spend_usd: number | null }; max: number }) {
  const val = item.spend_usd ?? 0;
  const pct = max > 0 ? Math.round((val / max) * 100) : 0;
  return <BarRow label={item.name.replace(':', ' · ')} value={leverageValue(item)} pct={pct} tone="measured" />;
}

export default function CodePulseOverviewPage() {
  const [data, setData] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor, vendorReady] = useVendor();
  // Only OpenAI connected: the Codex view, with nothing that only Claude Code can fill.
  const openaiOnly = useOpenAiOnly();

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/code/org-summary?vendor=${vendor}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || "Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [vendor, vendorReady]);

  if (loading) return <LoadingSpinner />;

  // Repo data only exists where cwd is captured (agent path / instances with it).
  // OTel-only instances have none — show Language Mix in that slot instead.
  const hasRepoData = !!data && ((data.metrics?.repo_count ?? 0) > 0 || (data.activeRepos?.length ?? 0) > 0 || (data.darkRepos?.length ?? 0) > 0);
  const repoOrLanguage = hasRepoData
    ? <RepoCoverageList active={data?.activeRepos ?? []} dark={data?.darkRepos ?? []} githubTotals={data?.githubOverlay?.totalCommits30dByRepo} />
    // Codex sends no edit decisions, so its view has no Language mix card.
    : openaiOnly || (vendor === 'openai' && data?.codexPresent) ? null : <LanguageMixCard items={data?.languageMix ?? []} />;

  const hasWorkMix = data?.workMix !== null && data?.workMix !== undefined;
  const codexPresent = data?.codexPresent ?? false;
  const view: Vendor = codexPresent || openaiOnly ? vendor : 'claude';
  // Claude Code's own row for the ratios only its telemetry can give.
  const claudeRow = view === 'openai' ? null : view === 'all' ? (data?.metricsSplit?.claude ?? null) : (data?.metrics ?? null);

  return (
    <>
      <TopBar title="Developer Pulse" subtitle="Engineering signals in plain language, measured rather than judged" />
      <PageBody>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <>
            <Toolbar
              left={data?.metrics
                ? `Last 7 days · ${formatTokens(data.metrics.input_tokens + data.metrics.output_tokens)} tokens processed`
                : 'Last 7 days'}
            >
              <span className="flex flex-wrap items-center justify-end gap-3.5 text-[13px] text-[#666666]">
                <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={codexPresent} labels={DEVELOPER_PULSE_VENDOR_LABELS} />
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-[#05073F]" />Measured</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-[#699BFB]" />AI-judged or estimate</span>
              </span>
            </Toolbar>
            {codexPresent && vendor !== 'all' && !openaiOnly && (
              <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">Showing {vendor === 'openai' ? 'Codex' : 'Claude Code'} only.</p>
            )}

            {/* Productivity strip: Claude Code's own telemetry (engaged time, lines, pull requests, edits). */}
            {openaiOnly ? null : view === 'openai' ? (
              <Notice tone="info">Engaged time, lines of code, pull requests and edit acceptance come from Claude Code&apos;s own telemetry. Codex doesn&apos;t send them, so they aren&apos;t shown for Codex.</Notice>
            ) : (
              <>
                {/* All view: Claude Code's telemetry figures, with commits from both tools. */}
                <CodeProductivityStrip metrics={view === 'all' && data!.metricsSplit?.claude && data!.metrics
                  ? { ...data!.metricsSplit.claude, commit_count: data!.metrics.commit_count }
                  : data!.metrics} />
                {view === 'all' && (
                  <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">Commits cover Claude Code and Codex. Engaged time, code output, pull requests and edit acceptance are Claude Code&apos;s: Codex doesn&apos;t send them.</p>
                )}
              </>
            )}

            {/* Verdicts — the executive read; everything below is the working detail */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {buildVerdicts(data!, view).map(v => <VerdictPanel key={v.question} v={v} />)}
            </div>

            {/* By hand vs with Claude sits after the verdicts, above This Week in Code. */}
            <HumanTimeCard summary={data!.humanTime} surface="code" scope="Org" view={view} />

            <CodeBriefingCard />

            {data?.githubOverlay && (
              <ShippingAlignmentChart series={data.githubOverlay.shippingSeries ?? []} codexPresent={codexPresent && vendor !== 'claude'} openaiOnly={openaiOnly || vendor === 'openai'} view={codexPresent || openaiOnly ? vendor : 'all'}>
                {(data.githubOverlay.repoCards?.length ?? 0) > 0
                  ? <GithubRepoCards cards={data.githubOverlay.repoCards} />
                  : undefined}
              </ShippingAlignmentChart>
            )}

            {data && data.unpricedModels.length > 0 && (
              <Notice
                tone="warn"
                title={`${data.unpricedModels.length} model${data.unpricedModels.length === 1 ? ' has' : 's have'} no price set`}
              >
                ({data.unpricedModels.join(', ')}), so their tokens are counted but excluded from spend.
                Admins can set rates via the Developer Pulse rates API.
              </Notice>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {hasWorkMix ? (
                <Panel title="Work mix" subtitle="30 days" right={<Tag tone="judged">AI-judged</Tag>} flush>
                  {data!.workMix!.length === 0 ? (
                    <div className="p-4">
                      <Muted>No sessions classified yet. The classifier runs every 30 minutes on sessions idle for 30+ minutes.</Muted>
                    </div>
                  ) : (
                    <div className="py-1">
                      {data!.workMix!.map(w => {
                        const max = data!.workMix![0].sessions;
                        return (
                          <BarRow
                            key={w.work_type}
                            title={w.definition ? `Covers: ${displayDefinition(w.definition)}` : undefined}
                            label={
                              <span className="inline-flex items-center gap-1.5">
                                {w.label ?? codeWorkTypeLabel(w.work_type)}
                                {w.provisional > 0 && (
                                  <span
                                    className="w-1.5 h-1.5 rounded-full border border-[#DC8A00] bg-[#FFF1E0] animate-pulse"
                                    title={`${w.provisional} provisional (session still active)`}
                                  />
                                )}
                              </span>
                            }
                            value={view === 'all' && codexPresent && w.claude != null && w.openai != null
                              ? <span className="flex flex-col items-end leading-tight"><span>{`${w.sessions} session${w.sessions === 1 ? '' : 's'}${w.tier3 > 0 ? ` · ${w.tier3} frontier` : ''}`}</span><span className="text-[12px] text-[#8F8F8F]">{formatSplit({ claude: w.claude, openai: w.openai }, 'Codex').replace(/^Claude/, 'Claude Code')}</span></span>
                              : `${w.sessions} session${w.sessions === 1 ? '' : 's'}${w.tier3 > 0 ? ` · ${w.tier3} frontier` : ''}`}
                            pct={Math.round((w.sessions / max) * 100)}
                            tone="judged"
                          />
                        );
                      })}
                    </div>
                  )}
                  <PanelFoot>
                    Session digests classified by Claude: the only judged numbers on this page. Everything else is measured.
                  </PanelFoot>
                </Panel>
              ) : (
                <ModelMixBar items={data?.modelMix ?? []} />
              )}
              {hasWorkMix
                ? <ModelMixBar items={data?.modelMix ?? []} />
                : repoOrLanguage}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {hasWorkMix && repoOrLanguage}
              <div className="flex flex-col gap-4">
                <Panel title="Top skills in Code" subtitle="30 days" flush>
                  {(data?.topSkills?.length ?? 0) === 0 ? (
                    <div className="p-4"><Muted>No skill invocations captured yet.</Muted></div>
                  ) : (
                    <div className="py-1">
                      {data!.topSkills.map((s, i) => (
                        <BarRow
                          key={s.skill_name}
                          rank={i + 1}
                          label={s.skill_name.replace(':', ' · ')}
                          value={`${s.uses}×${s.agent_chained > 0 ? ` · ${s.agent_chained} agent-chained` : ''}`}
                          pct={Math.round((s.uses / data!.topSkills[0].uses) * 100)}
                          tone="measured"
                        />
                      ))}
                    </div>
                  )}
                </Panel>
                <Panel title="Top connectors in Code" subtitle="30 days" flush>
                  {(data?.topConnectors?.length ?? 0) === 0 ? (
                    <div className="p-4"><Muted>No connector invocations captured yet.</Muted></div>
                  ) : (
                    <div className="py-1">
                      {data!.topConnectors.map((c, i) => (
                        <BarRow
                          key={c.mcp_server}
                          rank={i + 1}
                          label={c.mcp_server}
                          value={`${c.uses}×`}
                          pct={Math.round((c.uses / data!.topConnectors[0].uses) * 100)}
                          tone="measured"
                        />
                      ))}
                    </div>
                  )}
                </Panel>
              </div>
            </div>

            {((data?.skillLeverage?.length ?? 0) > 0 || (data?.agentLeverage?.length ?? 0) > 0) && (
              <Panel
                title={codexPresent ? 'Leverage: Claude Code spend by skill and subagent' : 'Leverage: spend by skill and subagent'}
                subtitle="30 days"
                right={data?.subagentShare != null
                  ? <span className="text-[13px] text-[#666666] tabular-nums">{Math.round(data.subagentShare * 100)}% of turns subagent-driven</span>
                  : undefined}
                flush
              >
                <div className="px-4 pt-3">
                  <Muted>API spend and turns attributed to the skill or subagent active during each request: which capabilities actually drive cost and output.</Muted>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 mt-2 border-t border-[#F2F2F2]">
                  <div className="pt-3 pb-1">
                    <div className="px-4"><SubHead>By skill</SubHead></div>
                    {(data?.skillLeverage?.length ?? 0) === 0 ? (
                      <div className="px-4 pb-3"><Muted>No skill-attributed turns yet.</Muted></div>
                    ) : (
                      data!.skillLeverage.map(s => (
                        <LeverageRow key={s.name} item={s} max={data!.skillLeverage[0].spend_usd ?? data!.skillLeverage[0].turns} />
                      ))
                    )}
                  </div>
                  <div className="pt-3 pb-1 border-t md:border-t-0 md:border-l border-[#F2F2F2]">
                    <div className="px-4"><SubHead>By subagent</SubHead></div>
                    {(data?.agentLeverage?.length ?? 0) === 0 ? (
                      <div className="px-4 pb-3"><Muted>No subagent-attributed turns yet.</Muted></div>
                    ) : (
                      data!.agentLeverage.map(a => (
                        <LeverageRow key={a.name} item={a} max={data!.agentLeverage[0].spend_usd ?? data!.agentLeverage[0].turns} />
                      ))
                    )}
                  </div>
                </div>
              </Panel>
            )}

            <EfficiencyCard metrics={data!.metrics} claude={claudeRow} />

            <SpendConcentrationCard data={data?.spendConcentration ?? null} />

            {(data?.highFrictionSessions?.length ?? 0) > 0 && (
              <Panel title="High-friction sessions" subtitle="7 days" flush>
                <div className="px-4 pt-3 pb-2">
                  <Muted>Sessions where over a quarter of tool actions failed: a coaching signal, not a fault list.</Muted>
                </div>
                <ul className="m-0 p-0 list-none">
                  {data!.highFrictionSessions.map(s => (
                    <li key={s.session_id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] text-[14px]">
                      <span className="text-[#0A0A0A] truncate min-w-0">
                        {s.repo ? <><span className="font-mono text-[13px]">{s.repo}</span><span className="text-[#8F8F8F]"> · </span></> : null}
                        <span className="font-medium">{s.user_display_name ?? 'unknown user'}</span>
                        <span className="text-[#8F8F8F]"> · {new Date(s.last_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                      </span>
                      <span className="text-[13px] text-[#B54708] tabular-nums shrink-0">
                        {s.error_count}/{s.tool_use_count} actions failed ({Math.round((s.error_count / s.tool_use_count) * 100)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Muted>
              Everything on this page except the Work mix is computed directly from session telemetry: token counts,
              tool actions, commits, repositories.
              {data && data.metrics ? ` Window: 7 days (lists 30 days) · ${formatTokens(data.metrics.input_tokens + data.metrics.output_tokens)} tokens processed.` : ''}
            </Muted>
          </>
        )}
      </PageBody>
    </>
  );
}

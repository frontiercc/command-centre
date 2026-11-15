// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import CodeStatStrip, { type CodeMetricsRow, formatTokens, formatCurrency } from '@/components/pulse/code/CodeStatStrip';
import CodeProductivityStrip from '@/components/pulse/code/CodeProductivityStrip';
import ModelMixBar, { type ModelMixItem } from '@/components/pulse/code/ModelMixBar';
import { DepthPanel, ByHandPanel, type ByHand, type Who } from '@/components/pulse/MyPulsePanels';
import {
  CodeWorkPanel, CodeBestWork, CodeWorkMix,
  type CodePeriodWork, type CodeWorkMixRow, type BestSession,
} from '@/components/pulse/code/CodePulsePanels';
import type { PulsePeriod } from '@/lib/pulse/period-shape';
import type { TierNames } from '@/lib/pulse/tier-names';
import Sparkline from '@/components/pulse/Sparkline';
import PriorPeriodBadge, { priorPeriodChange } from '@/components/pulse/code/PriorPeriodBadge';
import { PageBody, Toolbar, Panel, Tag, Empty, Muted, B } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { DEVELOPER_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';

interface SessionRow {
  session_id: string;
  repo: string | null;
  git_branch: string | null;
  first_at: number;
  last_at: number;
  user_msg_count: number;
  assistant_turns: number;
  tool_use_count: number;
  input_tokens: number;
  output_tokens: number;
  spend_usd: number | null;
  source: string;
}

interface WeeklyPoint {
  weekStart: number;
  value: number | null;
  partial: boolean;
}

interface WeeklyTrend {
  series: WeeklyPoint[];
  delta: { current: number | null; prior: number | null; pct: number | null };
}

interface MeData {
  periodWork?: CodePeriodWork | null;
  tierWeeks?: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  tierGrid?: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  tierNames?: TierNames | null;
  workMix?: CodeWorkMixRow[];
  bestSession?: BestSession | null;
  vendor?: Vendor;
  codexPresent?: boolean;
  metricsSplit?: { claude: CodeMetricsRow | null; openai: CodeMetricsRow | null } | null;
  humanTime?: ByHand | null;
  canSeeSpendReview?: boolean;
  userId: string | null;
  metrics: CodeMetricsRow | null;
  /** The 30 days before the headline window; null when nothing happened in them. */
  priorMetrics?: { active_time_user_s: number; lines_added: number } | null;
  trends: { engagedTime: WeeklyTrend; codeOutput: WeeklyTrend } | null;
  sessions: SessionRow[];
  modelMix: ModelMixItem[];
  journeyGrid: Array<{ week: number; tier: number; count: number; provisionalCount?: number }>;
  githubRepos: { count7d: number; names7d: string[] } | null;
}

/** `change`: the last 30 days on the 30 days before, as a fraction (null: nothing to compare with). */
function TrendCard({ label, trend, change }: { label: string; trend?: WeeklyTrend; change: number | null }) {
  if (!trend) return null;
  return (
    <Panel title={label} subtitle="8 weeks" right={<Tag tone="measured">Measured</Tag>}>
      <div className="flex flex-col gap-2">
        <Sparkline
          data={trend.series.map(p => p.value)}
          partialLast={trend.series[trend.series.length - 1]?.partial ?? false}
          label={label}
        />
        <div className="flex items-center gap-2 flex-wrap text-[13px] text-[#8F8F8F]">
          <span>Week to date shown hollow</span>
          <span className="ml-auto"><PriorPeriodBadge pct={change} /></span>
        </div>
      </div>
    </Panel>
  );
}

function formatDuration(first: number, last: number): string {
  const mins = Math.max(1, Math.round((last - first) / 60));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

function RecentSessions({ sessions }: { sessions: SessionRow[] }) {
  return (
    <Panel title="Recent sessions" flush>
      {sessions.length === 0 ? (
        <div className="p-4"><Muted>No sessions rolled up yet. Check back after the next hourly cycle.</Muted></div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {sessions.slice(0, 10).map(s => (
            <li key={s.session_id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
              <div className="min-w-0">
                <span className="block truncate text-[14px] font-medium text-[#0A0A0A]">
                  {s.repo ?? formatDate(s.last_at)}
                  {s.repo && s.git_branch && s.git_branch !== 'HEAD' && (
                    <span className="text-[#8F8F8F] font-normal"> · {s.git_branch}</span>
                  )}
                </span>
                <span className="block text-[13px] text-[#8F8F8F] tabular-nums">
                  {s.repo ? `${formatDate(s.last_at)} · ` : ''}{formatDuration(s.first_at, s.last_at)} · {s.user_msg_count} prompt{s.user_msg_count === 1 ? '' : 's'} · {s.tool_use_count} action{s.tool_use_count === 1 ? '' : 's'}
                </span>
              </div>
              <div className="shrink-0 text-right flex flex-col items-end gap-0.5">
                <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">
                  {s.spend_usd === null ? '—' : formatCurrency(s.spend_usd)}
                </span>
                <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                  {s.spend_usd === null && s.input_tokens + s.output_tokens === 0
                    ? 'not measured'
                    : `${formatTokens(s.input_tokens + s.output_tokens)} tokens`}
                </span>
                <Tag>{s.source === 'codex' ? 'Codex' : s.source === 'otel' ? 'OTel' : 'Agent'}</Tag>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MyCodePulseContent() {
  const searchParams = useSearchParams();
  // Admin/manager drill-down from the Users table; others get their own data
  const viewUserId = searchParams.get('userId');
  // Display name passed from the Users table link so the title reads as a name, not a hash
  const viewName = searchParams.get('name');

  const [data, setData] = useState<MeData | null>(null);
  // One period for the page, as on Work Pulse.
  const [period, setPeriod] = useState<PulsePeriod>('quarter');
  const [loading, setLoading] = useState(true);
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();
  // The view: Codex's own when it is the only coding tool connected.
  const codexView = !!data?.codexPresent || openaiOnly;

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    const qs = new URLSearchParams({ vendor });
    if (viewUserId) qs.set('userId', viewUserId);
    fetch(`/api/pulse/code/me?${qs.toString()}&period=${period}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [viewUserId, vendor, vendorReady, period]);

  if (loading) return <LoadingSpinner />;

  const who: Who = { you: !viewUserId, name: viewName || 'This person' };

  return (
    <>
      <TopBar
        title={viewUserId ? `Developer Pulse: ${viewName || viewUserId}` : 'My Developer Pulse'}
        subtitle={openaiOnly
          ? (viewUserId ? 'Per-user Codex activity' : 'Your Codex activity, spend, and autonomy')
          : data?.codexPresent
            ? (viewUserId ? 'Per-user coding activity: Claude Code and Codex' : 'Your coding activity, spend, and autonomy: Claude Code and Codex')
            : (viewUserId ? 'Per-user Claude Code activity' : 'Your Claude Code activity, spend, and autonomy')}
      />
      <PageBody className="dash-compact">
        {!data?.userId ? (
          openaiOnly ? (
            <Empty title="No Codex activity linked to your account yet">
              Codex activity is matched to your sign-in by email. It arrives from OpenAI&apos;s Compliance API a few hours after you use Codex.
            </Empty>
          ) : (
            <Empty title="No Claude Code activity linked to your account yet">
              Ask an admin to link your sign-in to your Claude identity on the Access & Keys page, or start a Claude Code session with telemetry on.
            </Empty>
          )
        ) : (
          <>
            {(data.canSeeSpendReview || data.codexPresent) && (
              <Toolbar>
                <span className="flex flex-wrap items-center gap-3">
                  <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={data.codexPresent ?? false} labels={DEVELOPER_PULSE_VENDOR_LABELS} />
                  {data.canSeeSpendReview && (
                    <Link href={`/finops/spend-review/${encodeURIComponent(data.userId)}`} className={B.link}>
                      {viewUserId ? 'Spend review' : 'Your spend review'}
                    </Link>
                  )}
                </span>
              </Toolbar>
            )}

            {/* 1. The coding work of the period */}
            {data.periodWork && (
              <CodeWorkPanel
                w={data.periodWork}
                who={who}
                period={period}
                onPeriod={setPeriod}
                product={openaiOnly ? 'Codex' : data.codexPresent && vendor === 'all' ? 'Claude Code and Codex' : vendor === 'openai' ? 'Codex' : 'Claude Code'}
              />
            )}

            {/* 2. Best work this week */}
            <CodeBestWork s={data.bestSession ?? null} who={who} names={data.tierNames ?? undefined} />

            {/* 3. Is the work getting deeper? */}
            {(data.tierGrid?.length ?? 0) > 0 && (
              <DepthPanel
                weeks={data.tierWeeks ?? []}
                grid={data.tierGrid ?? []}
                end={Math.floor(Date.now() / 1000)}
                names={data.tierNames ?? undefined}
                title={`Is ${who.you ? 'your' : `${who.name}'s`} work getting deeper?`}
                subject={who.you ? 'you ran' : `${who.name} ran`}
                whose={who.you ? 'your' : `${who.name}'s`}
                unit="session"
              />
            )}

            {/* 4 and 5 */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <CodeWorkMix rows={data.workMix ?? []} who={who} names={data.tierNames ?? undefined} />
              <ByHandPanel h={data.humanTime} who={who} tool={openaiOnly || vendor === 'openai' ? 'Codex' : data.codexPresent && vendor === 'all' ? 'AI' : 'Claude Code'} />
            </div>

            {/* 6. The measured detail behind it */}
            <CodeStatStrip metrics={data.metrics} githubRepos={data.githubRepos} view={codexView ? vendor : 'claude'} split={data.metricsSplit} />

            {openaiOnly ? null : data.codexPresent && vendor === 'openai'
              ? <Muted>Engaged time, lines of code, pull requests and edit acceptance come from Claude Code&apos;s own telemetry. Codex doesn&apos;t send them.</Muted>
              : <CodeProductivityStrip metrics={data.codexPresent && vendor === 'all' && data.metricsSplit?.claude && data.metrics
                  ? { ...data.metricsSplit.claude, commit_count: data.metrics.commit_count }
                  : data.metrics} />}

            {data.trends && !openaiOnly && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <TrendCard label="Engaged time" trend={data.trends.engagedTime} change={priorPeriodChange(data.metrics?.active_time_user_s, data.priorMetrics?.active_time_user_s)} />
                <TrendCard label="Code output" trend={data.trends.codeOutput} change={priorPeriodChange(data.metrics?.lines_added, data.priorMetrics?.lines_added)} />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ModelMixBar items={data.modelMix} title="Your model mix" />
              <RecentSessions sessions={data.sessions} />
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

export default function MyCodePulsePage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <MyCodePulseContent />
    </Suspense>
  );
}

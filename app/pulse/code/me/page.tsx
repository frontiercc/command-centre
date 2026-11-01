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
import JourneyGrid from '@/components/pulse/JourneyGrid';
import Sparkline from '@/components/pulse/Sparkline';
import WeeklyDeltaBadge from '@/components/pulse/WeeklyDeltaBadge';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, Tag, Empty, Muted, B } from '@/components/precision/ui';
import { useVendor, VendorSwitch } from '@/components/shared/VendorSwitch';
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
  vendor?: Vendor;
  codexPresent?: boolean;
  metricsSplit?: { claude: CodeMetricsRow | null; openai: CodeMetricsRow | null } | null;
  humanTime?: HumanTimeSummary | null;
  canSeeSpendReview?: boolean;
  userId: string | null;
  metrics: CodeMetricsRow | null;
  trends: { engagedTime: WeeklyTrend; codeOutput: WeeklyTrend } | null;
  sessions: SessionRow[];
  modelMix: ModelMixItem[];
  journeyGrid: Array<{ week: number; tier: number; count: number; provisionalCount?: number }>;
  githubRepos: { count7d: number; names7d: string[] } | null;
}

function TrendCard({ label, trend }: { label: string; trend?: WeeklyTrend }) {
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
          <span className="ml-auto"><WeeklyDeltaBadge pct={trend.delta.pct} /></span>
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
  return new Date(epoch * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
                  {s.repo ? `${formatDate(s.last_at)} · ` : ''}{formatDuration(s.first_at, s.last_at)} · {s.user_msg_count} prompts · {s.tool_use_count} actions
                </span>
              </div>
              <div className="shrink-0 text-right flex flex-col items-end gap-0.5">
                <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">
                  {s.spend_usd === null ? '—' : formatCurrency(s.spend_usd)}
                </span>
                <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                  {formatTokens(s.input_tokens + s.output_tokens)} tokens
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
  const [loading, setLoading] = useState(true);
  const [vendor, setVendor] = useVendor();

  useEffect(() => {
    const qs = new URLSearchParams({ vendor });
    if (viewUserId) qs.set('userId', viewUserId);
    fetch(`/api/pulse/code/me?${qs.toString()}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [viewUserId, vendor]);

  if (loading) return <LoadingSpinner />;

  return (
    <>
      <TopBar
        title={viewUserId ? `Developer Pulse: ${viewName || viewUserId}` : 'My Developer Pulse'}
        subtitle={data?.codexPresent
          ? (viewUserId ? 'Per-user coding activity: Claude Code and Codex' : 'Your coding activity, spend, and autonomy: Claude Code and Codex')
          : (viewUserId ? 'Per-user Claude Code activity' : 'Your Claude Code activity, spend, and autonomy')}
      />
      <PageBody>
        {!data?.userId ? (
          <Empty title="No Claude Code activity linked to your account yet">
            Ask an admin to link your sign-in to your Claude identity on the Access & Keys page, or start a Claude Code session with telemetry on.
          </Empty>
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

            <CodeStatStrip metrics={data.metrics} githubRepos={data.githubRepos} view={data.codexPresent ? vendor : 'claude'} split={data.metricsSplit} />

            {data.codexPresent && vendor === 'openai'
              ? <Muted>Engaged time, lines of code, pull requests and edit acceptance come from Claude Code&apos;s own telemetry. Codex doesn&apos;t send them.</Muted>
              : <CodeProductivityStrip metrics={data.codexPresent && vendor === 'all' && data.metricsSplit?.claude && data.metrics
                  ? { ...data.metricsSplit.claude, commit_count: data.metrics.commit_count }
                  : data.metrics} />}

            <HumanTimeCard summary={data.humanTime} surface="code" scope="Personal" />

            {data.trends && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <TrendCard label="Engaged time" trend={data.trends.engagedTime} />
                <TrendCard label="Code output" trend={data.trends.codeOutput} />
              </div>
            )}

            {(data.journeyGrid?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag tone="judged">AI-judged</Tag>
                  <span className="text-[13px] text-[#8F8F8F]">Your delegation journey, 6 weeks: session tiers from the digest classifier</span>
                </div>
                <JourneyGrid data={data.journeyGrid} />
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

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The Dashboard's Developer Pulse panel: an answer line and four plain questions (cost, what it
 * shipped, how much developers delegate, repos reached), the same card layout as the Work Pulse
 * panel above it. Last 30 days against the 30 days before. A figure that isn't captured says so.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Tag, Muted, LOAD_FAILED } from '@/components/precision/ui';
import { formatCurrency, type CodeMetricsRow } from '@/components/pulse/code/CodeStatStrip';
import { QuestionCard, changeFrom } from '@/components/dashboard/QuestionCard';

interface WeeklyPoint { weekStart: number; value: number | null; partial: boolean }

interface BandData {
  codexPresent?: boolean;
  metrics: CodeMetricsRow | null;
  priorMetrics: { spend_usd: number | null; autonomy_ratio: number | null; session_count: number } | null;
  trends?: { spend: { series: WeeklyPoint[] }; autonomy: { series: WeeklyPoint[] }; commits: { series: WeeklyPoint[] } };
  spendProjection: { projected: number } | null;
  githubOverlay: { totalCommits7d: number; totalPrs7d?: number; reposActive7d?: number; reposActive30d?: number; trackedRepoCount?: number } | null;
}

/** `vendor` is the dashboard's switch: Developer Pulse's figures follow it (Codex in the OpenAI view). */
export default function CodePulseBand({ vendor = 'all' }: { vendor?: 'all' | 'claude' | 'openai' }) {
  const [data, setData] = useState<BandData | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`/api/pulse/code/org-summary?vendor=${vendor}`)
      .then(r => {
        if (r.status === 403 || r.status === 401) { setForbidden(true); return null; }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(d => { if (d) { setData(d); setFailed(false); } })
      .catch(() => { setData(null); setFailed(true); });
  }, [vendor]);

  // Not this role's to see: no band. Loading or failed: the band keeps its place and says which.
  if (forbidden) return null;
  if (!data) return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5">
      <h2 className="m-0 mb-2 text-[14px] font-semibold text-[#0A0A0A]">Developer Pulse</h2>
      <Muted>{failed ? LOAD_FAILED : 'Loading…'}</Muted>
    </section>
  );
  const m = data.metrics;
  const tool = vendor === 'openai' ? 'Codex' : vendor === 'claude' || !data.codexPresent ? 'Claude Code' : 'Claude Code and Codex';
  const series = (s?: WeeklyPoint[]) => (s ?? []).filter(p => !p.partial).map(p => p.value);

  const spend = m?.spend_usd ?? null;
  const priorSpend = data.priorMetrics?.spend_usd ?? null;
  const commits = m?.commit_count ?? null;
  // Pull requests opened in Claude Code and Codex sessions (telemetry), like the commits beside them:
  // AI work only, and following the view. GitHub's merged pull requests count every change, AI or not.
  const prs = m?.pr_count ?? null;
  const autonomy = m?.autonomy_ratio ?? null;
  const priorAutonomy = data.priorMetrics?.autonomy_ratio ?? null;
  // GitHub's count over the same 30 days as the rest of the band.
  const ghRepos = data.githubOverlay?.reposActive30d;
  const repos = (m?.repo_count ?? 0) > 0 ? m!.repo_count : ghRepos !== undefined ? ghRepos : null;

  const spendChange = spend !== null && priorSpend !== null && priorSpend > 0
    ? (() => { const p = Math.round(((spend - priorSpend) / priorSpend) * 100); return p === 0 ? 'the same as the 30 days before' : `${Math.abs(p)}% ${p > 0 ? 'more' : 'less'} than the 30 days before`; })()
    : null;

  const answer = commits !== null && commits > 0
    ? <>{tool} helped make <b>{commits.toLocaleString('en-GB')} commits</b> in the last 30 days{spend !== null ? <>, for <b>{formatCurrency(spend)}</b></> : null}.</>
    : spend !== null
      ? <>{tool} cost <b>{formatCurrency(spend)}</b> in the last 30 days{spendChange ? `, ${spendChange}` : ''}.</>
      : null;

  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Developer Pulse</h2>
        <Tag tone="neutral">Measured</Tag>
        <span className="ml-auto text-[12px] text-[#8F8F8F]">{data.priorMetrics ? 'Last 30 days against the 30 days before' : 'Last 30 days'}</span>
      </div>
      {answer && <p className="m-0 mt-2 text-[14px] leading-[22px] text-[#1A1A1A] [&_b]:font-semibold">{answer}</p>}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 mt-3">
        <QuestionCard
          question="What did it cost?"
          value={spend !== null ? formatCurrency(spend) : undefined}
          change={spendChange}
          sub={data.spendProjection ? `on pace for ${formatCurrency(data.spendProjection.projected)} this month (estimate)` : undefined}
          trend={series(data.trends?.spend.series)}
          trendKind="bars"
          notMeasured={spend === null ? 'No priced model calls in the last 30 days' : undefined}
        />
        <QuestionCard
          question="What did it ship?"
          value={commits !== null ? commits.toLocaleString('en-GB') : undefined}
          unit="commits"
          sub={prs !== null && prs > 0 ? `${prs.toLocaleString('en-GB')} ${prs === 1 ? 'pull request' : 'pull requests'} opened` : undefined}
          trend={series(data.trends?.commits.series)}
          trendKind="bars"
          notMeasured={commits === null ? 'No commits recorded yet' : undefined}
        />
        <QuestionCard
          question="How much do developers delegate?"
          value={autonomy !== null ? autonomy.toFixed(1) : undefined}
          unit="actions per prompt"
          change={changeFrom(autonomy, priorAutonomy, v => v.toFixed(1), 'the 30 days before')}
          trend={series(data.trends?.autonomy.series)}
          notMeasured={autonomy === null ? 'Needs sessions with tool actions' : undefined}
        />
        <QuestionCard
          question="How many repos does it reach?"
          value={repos !== null ? String(repos) : undefined}
          unit={repos !== null ? (ghRepos !== undefined && (m?.repo_count ?? 0) === 0 ? `of ${data.githubOverlay?.trackedRepoCount ?? 0} tracked on GitHub` : 'repos') : undefined}
          notMeasured={repos === null ? <>Connect GitHub to see repos. <Link href="/admin/code-pulse?tab=github" className="text-[#1F6F8B] hover:underline">Set up</Link></> : undefined}
        />
      </div>
      <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] text-[#8F8F8F]">
        Measured from {tool} telemetry. Bars and lines show the last 8 completed weeks. <Link href="/pulse/code" className="text-[#1F6F8B] font-medium hover:underline">Open Developer Pulse</Link>
      </p>
    </section>
  );
}

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ReactNode } from 'react';
import { Strip, Figure, cx } from '@/components/precision/ui';

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCurrency(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Headline figures joined into a row with hairline dividers, for use INSIDE a
 * flush Panel (the kit's Strip carries its own border and would double it).
 */
export function FigureGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 | 6 }) {
  const grid = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-3 lg:grid-cols-5',
    6: 'sm:grid-cols-3 lg:grid-cols-6',
  }[cols];
  return (
    <div className={cx('grid grid-cols-1', grid,
      '[&>*]:border-[#EAEAEA] [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l')}>
      {children}
    </div>
  );
}

/** A figure whose value has not arrived yet: grey words, never a fabricated 0. */
export function PendingValue({ children }: { children: ReactNode }) {
  return <span className="text-[16px] font-medium tracking-normal text-[#8F8F8F]">{children}</span>;
}

interface CodeSignal {
  label: string;
  value: string | null;
  sublabel: string;
  hint: string;
  pending?: string;
}

function CodeSignalFigure({ signal }: { signal: CodeSignal }) {
  return (
    <Figure
      label={signal.label}
      value={signal.value === null ? <PendingValue>{signal.pending ?? 'Pending data'}</PendingValue> : signal.value}
      sub={<><span className="block text-[#666666]">{signal.sublabel}</span><span className="block">{signal.hint}</span></>}
    />
  );
}

export interface CodeMetricsRow {
  spend_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_hit_ratio: number | null;
  autonomy_ratio: number | null;
  session_count: number;
  repo_count: number;
  commit_count?: number;
  skill_leverage: number | null;
  friction_index: number | null;
  // Phase 1 OTel productivity metrics (optional — null/absent until metrics flow)
  active_time_user_s?: number;
  active_time_cli_s?: number;
  lines_added?: number;
  lines_removed?: number;
  pr_count?: number;
  edit_accept_count?: number;
  edit_reject_count?: number;
}

/** "1h 23m" / "45m" / "30s" from a seconds count. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export default function CodeStatStrip({ metrics, githubRepos }: { metrics: CodeMetricsRow | null; githubRepos?: { count7d: number; names7d: string[] } | null }) {
  const signals: CodeSignal[] = [
    {
      label: 'Claude spend · 7 days',
      value: metrics === null ? null : metrics.spend_usd === null
        ? null
        : formatCurrency(metrics.spend_usd),
      sublabel: 'API cost of Claude Code work',
      hint: metrics?.spend_usd === null && (metrics.input_tokens + metrics.output_tokens) > 0
        ? 'Models seen have no price set, see rates config'
        : `${formatTokens(metrics?.input_tokens ?? 0)} in · ${formatTokens(metrics?.output_tokens ?? 0)} out`,
      pending: metrics && metrics.spend_usd === null ? 'Unpriced' : undefined,
    },
    {
      label: 'Automation',
      value: metrics?.autonomy_ratio == null ? null : `${metrics.autonomy_ratio.toFixed(1)}×`,
      sublabel: 'Actions Claude takes per instruction given',
      hint: 'Tool actions ÷ human prompts, per session',
    },
    // GitHub takes precedence even where a session-derived repo_count also
    // exists — deliberate; no current instance has both data sources at once.
    githubRepos != null
      ? {
          label: 'Repos active · 7 days (GitHub)',
          value: String(githubRepos.count7d),
          sublabel: githubRepos.names7d.length > 0
            ? (githubRepos.count7d > githubRepos.names7d.length
                ? `${githubRepos.names7d.join(' · ')} · +${githubRepos.count7d - githubRepos.names7d.length} more`
                : githubRepos.names7d.join(' · '))
            : 'Repos with your GitHub commits',
          hint: githubRepos.count7d === 0
            ? 'From GitHub commit-author matching; a zero can also mean unmapped commits'
            : 'From GitHub commit-author matching',
        }
      : metrics !== null && metrics.repo_count === 0
        ? {
            label: 'Repos active · 7 days',
            value: null,
            pending: 'Not captured',
            sublabel: 'Codebases with Claude activity',
            hint: `${metrics.session_count} session${metrics.session_count === 1 ? '' : 's'} · no repo attribution in these sessions`,
          }
        : {
            label: 'Repos active · 7 days',
            value: metrics == null ? null : String(metrics.repo_count),
            sublabel: 'Codebases with Claude activity',
            hint: `${metrics?.session_count ?? 0} session${(metrics?.session_count ?? 0) === 1 ? '' : 's'} · ${metrics?.commit_count ?? 0} AI-assisted commit${(metrics?.commit_count ?? 0) === 1 ? '' : 's'}`,
          },
    {
      label: 'Cache efficiency',
      value: metrics?.cache_hit_ratio == null ? null : `${Math.round(metrics.cache_hit_ratio * 100)}%`,
      sublabel: 'Context served from cache, not re-billed',
      hint: 'Higher is cheaper: cache reads cost about 10% of fresh input',
    },
  ];

  return (
    <Strip cols={4}>
      {signals.map(s => <CodeSignalFigure key={s.label} signal={s} />)}
    </Strip>
  );
}

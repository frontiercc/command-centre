// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Strip, Figure } from '@/components/precision/ui';
import { formatCurrency, formatTokens, type CodeMetricsRow } from '@/components/pulse/code/CodeStatStrip';

interface BandData {
  metrics: CodeMetricsRow | null;
  githubOverlay: { totalCommits7d: number; reposActive7d?: number; trackedRepoCount?: number } | null;
}

export default function CodePulseBand() {
  const [data, setData] = useState<BandData | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    fetch('/api/pulse/code/org-summary')
      .then(r => {
        if (r.status === 403 || r.status === 401) { setForbidden(true); return null; }
        return r.json();
      })
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);

  if (forbidden || !data) return null;
  const m = data.metrics;

  // Phase 3 overlay framing: AI-assisted commits lead; GitHub volume is context only
  // (the in-session share field no longer exists in the org-summary payload).
  const shipping = String(m?.commit_count ?? 0);
  const shippingDesc = data.githubOverlay && data.githubOverlay.totalCommits7d > 0
    ? `AI-assisted commits this week · ${data.githubOverlay.totalCommits7d} on GitHub across tracked repos`
    : 'Commits made inside Claude Code sessions';

  const githubRepos = (m?.repo_count ?? 0) === 0 && data.githubOverlay?.reposActive7d !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap">
        <h3 className="m-0 text-[14px] font-semibold text-[#0A0A0A]"><span className="text-[#245BF3] font-mono" aria-hidden="true">{'</>'}</span> Developer Pulse</h3>
        <span className="text-[13px] text-[#8F8F8F]">Engineering signals · 7 days · measured, not judged</span>
        <Link href="/pulse/code" className="ml-auto text-[13px] font-medium text-[#245BF3] hover:underline">
          Open Developer Pulse
        </Link>
      </div>
      <Strip cols={4}>
        <Figure
          label="Spend"
          value={m?.spend_usd == null ? '—' : formatCurrency(m.spend_usd)}
          sub={`${formatTokens((m?.input_tokens ?? 0) + (m?.output_tokens ?? 0))} tokens this week`}
        />
        <Figure
          label="Automation"
          value={m?.autonomy_ratio == null ? '—' : `${m.autonomy_ratio.toFixed(1)}×`}
          sub="Actions Claude takes per instruction"
        />
        <Figure label="Shipping" value={shipping} sub={shippingDesc} />
        {githubRepos ? (
          <Figure
            label="Repos"
            value={String(data.githubOverlay!.reposActive7d)}
            sub={`GitHub-tracked repos with commits this week · ${data.githubOverlay!.trackedRepoCount ?? 0} tracked`}
          />
        ) : (
          <Figure
            label="Repos"
            value={String(m?.repo_count ?? 0)}
            sub={`${m?.session_count ?? 0} sessions across active codebases`}
          />
        )}
      </Strip>
    </div>
  );
}

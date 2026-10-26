// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Strip, Figure } from '@/components/precision/ui';
import { type CodeMetricsRow, formatDuration, PendingValue } from './CodeStatStrip';

/**
 * Phase 1 OTel productivity strip — the developer-and-activity signals the OTel
 * metrics stream provides (engaged time, output, shipping, edit acceptance).
 * Repo-independent: works without cwd, which Claude Code OTel does not export.
 */

interface Signal {
  label: string;
  value: string | null;
  sublabel: string;
  hint: string;
}

export default function CodeProductivityStrip({ metrics }: { metrics: CodeMetricsRow | null }) {
  const m = metrics;

  // "Awaiting metrics" until the OTel metrics stream is flowing (all zero/absent).
  const hasAny = !!m && (
    (m.active_time_user_s ?? 0) + (m.active_time_cli_s ?? 0) +
    (m.lines_added ?? 0) + (m.lines_removed ?? 0) +
    (m.pr_count ?? 0) + (m.edit_accept_count ?? 0) + (m.edit_reject_count ?? 0)
  ) > 0;

  const engagedTotal = (m?.active_time_user_s ?? 0) + (m?.active_time_cli_s ?? 0);
  const accepts = m?.edit_accept_count ?? 0;
  const rejects = m?.edit_reject_count ?? 0;
  const decisions = accepts + rejects;
  const acceptRate = decisions > 0 ? Math.round((accepts / decisions) * 100) : null;
  const commits = m?.commit_count ?? 0;
  const prs = m?.pr_count ?? 0;

  const signals: Signal[] = [
    {
      label: 'Engaged time · 7 days',
      value: hasAny ? formatDuration(engagedTotal) : null,
      sublabel: 'Active AI-assisted engineering time',
      hint: `${formatDuration(m?.active_time_user_s ?? 0)} interacting · ${formatDuration(m?.active_time_cli_s ?? 0)} processing`,
    },
    {
      label: 'Code output · 7 days',
      value: hasAny ? `+${(m?.lines_added ?? 0).toLocaleString()}` : null,
      sublabel: 'Lines added with Claude Code',
      hint: `−${(m?.lines_removed ?? 0).toLocaleString()} removed`,
    },
    {
      label: 'Shipping · 7 days',
      value: hasAny ? String(commits) : null,
      sublabel: 'AI-assisted commits',
      hint: `${prs} pull request${prs === 1 ? '' : 's'} merged`,
    },
    {
      label: 'Edit acceptance',
      value: acceptRate === null ? null : `${acceptRate}%`,
      sublabel: 'Edits accepted vs rejected',
      hint: decisions > 0 ? `${accepts} accepted · ${rejects} rejected` : 'No edit decisions in the window',
    },
  ];

  return (
    <div className="ccc-strip">
      <Strip cols={4}>
        {signals.map(s => (
          <Figure
            key={s.label}
            label={s.label}
            value={s.value === null ? <PendingValue>Awaiting metrics</PendingValue> : s.value}
            sub={<><span className="block text-[#666666]">{s.sublabel}</span><span className="block tabular-nums">{s.hint}</span></>}
          />
        ))}
      </Strip>
    </div>
  );
}

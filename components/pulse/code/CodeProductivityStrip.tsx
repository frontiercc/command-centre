// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Strip, Figure } from '@/components/precision/ui';
import { type CodeMetricsRow, formatDuration, roundDurationSeconds, PendingValue } from './CodeStatStrip';

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

  // The total of the two parts as shown, so it reads as their sum.
  const engagedTotal = roundDurationSeconds(m?.active_time_user_s ?? 0) + roundDurationSeconds(m?.active_time_cli_s ?? 0);
  const accepts = m?.edit_accept_count ?? 0;
  const rejects = m?.edit_reject_count ?? 0;
  const decisions = accepts + rejects;
  const acceptRate = decisions > 0 ? Math.round((accepts / decisions) * 100) : null;
  const commits = m?.commit_count ?? 0;
  const prs = m?.pr_count ?? 0;

  const signals: Signal[] = [
    {
      label: 'Engaged time · 30 days',
      value: hasAny ? formatDuration(engagedTotal) : null,
      sublabel: 'Active AI-assisted engineering time',
      hint: `${formatDuration(m?.active_time_user_s ?? 0)} people at the keyboard · ${formatDuration(m?.active_time_cli_s ?? 0)} Claude working`,
    },
    {
      label: 'Code output · 30 days',
      value: hasAny ? `+${(m?.lines_added ?? 0).toLocaleString('en-GB')}` : null,
      sublabel: 'Lines added with Claude Code',
      hint: `−${(m?.lines_removed ?? 0).toLocaleString('en-GB')} removed`,
    },
    {
      label: 'Shipping · 30 days',
      // Commits come from session data (Claude Code and Codex), not the
      // metrics stream, so they show as soon as there are any.
      value: hasAny || commits > 0 ? commits.toLocaleString('en-GB') : null,
      sublabel: 'AI-assisted commits',
      hint: `${prs.toLocaleString('en-GB')} pull request${prs === 1 ? '' : 's'} opened`,
    },
    {
      label: 'Edit acceptance · 30 days',
      value: acceptRate === null ? null : `${acceptRate}%`,
      sublabel: 'Edits accepted vs rejected',
      hint: decisions > 0 ? `${accepts.toLocaleString('en-GB')} accepted · ${rejects.toLocaleString('en-GB')} rejected` : 'No edit decisions in the window',
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

// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Who is using Claude?": people active each week (one series, measured), and the
 * departments below the adoption target as the needs-attention list. Quiet on the department
 * list when every department is at or above target.
 */
import { AnswerPanel, Columns, TargetBars, AC } from '@/components/precision/answer';
import { countChangeWords, dayMonth, fmtInt, listWords, plural } from '@/lib/ui/answer-text';
import type { Vendor } from '@/lib/dashboard/vendor';

interface Dept { department: string; user_count: number; active_users: number }

export default function WhoIsUsing({ weeklyActive, departments, targetPct, vendor, openaiPresent }: {
  weeklyActive: Array<{ endS: number; people: number }>;
  departments: Dept[];
  targetPct: number | null;
  vendor: Vendor;
  openaiPresent: boolean;
}) {
  const products = vendor === 'openai' ? 'ChatGPT or Codex' : vendor === 'claude' || !openaiPresent ? 'Claude' : 'Claude, ChatGPT or Codex';
  const last = weeklyActive[weeklyActive.length - 1]?.people ?? 0;
  const prev = weeklyActive.length >= 2 ? weeklyActive[weeklyActive.length - 2].people : null;
  const change = countChangeWords(last, prev);

  const rated = departments
    .filter(d => d.user_count > 0)
    .map(d => ({ name: d.department, pct: (d.active_users / d.user_count) * 100, active: d.active_users, total: d.user_count }))
    .sort((a, b) => a.pct - b.pct);
  const below = targetPct === null ? [] : rated.filter(d => d.pct < targetPct);
  const shownBelow = below.slice(0, 5);

  const deptSentence = targetPct === null
    ? null
    : below.length === 0
      ? ` Every department is at or above your ${fmtInt(targetPct)}% target.`
      : below.length <= 2
        ? ` ${listWords(below.map(d => d.name))} ${below.length === 1 ? 'is' : 'are'} below your ${fmtInt(targetPct)}% target.`
        : ` ${plural(below.length, 'department')} are below your ${fmtInt(targetPct)}% target.`;

  return (
    <AnswerPanel
      question={`Who is using ${products}?`}
      period="Last 8 weeks"
      tag="measured"
      answer={<><b>{plural(last, 'person', 'people')}</b> used {products} in the last 7 days{change ? `, ${change} the week before` : ''}.{deptSentence}</>}
      detail={{ href: '/users', label: `See all ${plural(rated.length, 'department')} and their people` }}
      note={<>a person counts in a week if they sent at least one prompt in any product. Department share is people active in the last 7 days out of everyone in the department.{targetPct !== null ? ' The target is set in Admin → System.' : ''}</>}
    >
      <Columns
        labels={weeklyActive.map(w => dayMonth(w.endS))}
        series={[{ label: 'People', colour: AC.measured, values: weeklyActive.map(w => w.people) }]}
        callout={{ index: weeklyActive.length - 1, text: `${fmtInt(last)} people` }}
      />
      {shownBelow.length > 0 && targetPct !== null && (
        <div className="mt-4 pt-3 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-1">Below the {fmtInt(targetPct)}% department target</div>
          <TargetBars
            rows={shownBelow.map(d => ({ key: d.name, label: d.name, value: d.pct, display: `${Math.round(d.pct)}%`, href: `/users?department=${encodeURIComponent(d.name)}` }))}
            max={100}
            target={{ value: targetPct, label: `Target ${fmtInt(targetPct)}%`, worse: 'below' }}
          />
          {below.length > shownBelow.length && <div className="text-[12px] text-[#8F8F8F] pt-1">and {below.length - shownBelow.length} more below target</div>}
        </div>
      )}
    </AnswerPanel>
  );
}

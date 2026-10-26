// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { NamedSpend, SpendSplit } from '@/lib/finance/where-money-went';

/** Shared by the Audit Log's Session stats and Spend Review's kinds of work. */

const SHOWN = 3;

export function spendMoney(n: number): string {
  if (n > 0 && n < 0.01) return 'under $0.01';
  return `$${n.toLocaleString('en-GB', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

function NamedList({ label, items, mono }: { label: string; items: NamedSpend[]; mono?: boolean }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, SHOWN);
  const rest = items.length - shown.length;
  const full = items.map(i => `${i.name}: ${spendMoney(i.usd)} (${i.calls} call${i.calls === 1 ? '' : 's'})`).join('\n');
  return (
    <span className="text-[13px] text-[#666666] tabular-nums" title={full}>
      {label}:{' '}
      {shown.map((i, n) => (
        <span key={i.name}>
          {n > 0 && <span className="text-[#B3B3B3]"> · </span>}
          <span className={mono ? 'font-mono text-[12px] text-[#333333]' : 'text-[#333333]'}>{i.name}</span> {spendMoney(i.usd)}
        </span>
      ))}
      {rest > 0 && <span className="text-[#8F8F8F]"> · +{rest} more</span>}
    </span>
  );
}

/** "Main conversation $1.10 · Subagents $3.11", shown only when subagents (or unrecorded calls) carry spend. */
export function SplitLine({ s }: { s: SpendSplit }) {
  if (s.subagentUsd <= 0 && s.notRecordedUsd <= 0) return null;
  const parts: string[] = [];
  if (s.mainUsd > 0) parts.push(`Main conversation ${spendMoney(s.mainUsd)}`);
  if (s.subagentUsd > 0) parts.push(`Subagents ${spendMoney(s.subagentUsd)}`);
  if (s.notRecordedUsd > 0) parts.push(`Not recorded ${spendMoney(s.notRecordedUsd)}`);
  return (
    <span
      className="text-[13px] text-[#333333] tabular-nums"
      title={s.notRecordedUsd > 0 ? 'Not recorded: calls from before Claude reported whether a subagent made them.' : undefined}
    >
      {parts.join(' · ')}
    </span>
  );
}

export default function WhereMoneyWent({ s, showModels = false }: { s: SpendSplit; showModels?: boolean }) {
  return (
    <span className="flex flex-col gap-1">
      <SplitLine s={s} />
      {showModels && <NamedList label="By model" items={s.byModel} mono />}
      <NamedList label="Subagents" items={s.bySubagent} mono />
      <NamedList label="Skills" items={s.bySkill} mono />
    </span>
  );
}

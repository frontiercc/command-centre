// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// One cell of a Precision figure strip. Place several inside <Strip> from
// '@/components/precision/ui'; the strip draws the hairline dividers.
import { Figure, Tag, type Tone } from '@/components/precision/ui';

const PILL_TONE: Record<string, 'neutral' | 'warn'> = {
  default: 'neutral',
  green: 'neutral',
  amber: 'warn',
  blue: 'neutral',
  purple: 'neutral',
};

function changeTone(change: string): Tone | undefined {
  if (change.startsWith('+') || change.startsWith('↑')) return 'good';
  if (change.startsWith('-') || change.startsWith('↓')) return 'bad';
  return undefined;
}

export default function StatCard({
  title,
  value,
  change,
  subtitle,
  pill,
  pillVariant = 'default',
  pillTooltip,
  action,
}: {
  title: string;
  value: string | number;
  change?: string;
  subtitle?: string;
  pill?: string;
  pillVariant?: 'default' | 'green' | 'amber' | 'blue' | 'purple';
  pillTooltip?: string;
  action?: React.ReactNode;
}) {
  const shown = typeof value === 'number' ? value.toLocaleString('en-GB') : value;

  return (
    <div className="flex flex-col min-w-0">
      <Figure
        label={
          <span className="flex items-center gap-2 flex-wrap">
            <span>{title}</span>
            {pill && <Tag tone={PILL_TONE[pillVariant] ?? 'neutral'} title={pillTooltip}>{pill}</Tag>}
          </span>
        }
        value={shown}
        delta={change || undefined}
        deltaTone={change ? changeTone(change) : undefined}
        sub={subtitle}
      />
      {action && <div className="px-4 pb-4 -mt-1 text-[13px] text-[#8F8F8F]">{action}</div>}
    </div>
  );
}

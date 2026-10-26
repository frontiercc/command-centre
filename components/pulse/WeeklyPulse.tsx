// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ReactNode } from 'react';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { Panel, Tag, Muted, Notice } from '@/components/precision/ui';

interface WeeklyPulseProps {
  briefing: {
    body: string;
    suggestion: string | null;
    generated_at: number;
  } | null;
  // When userId is provided, show generate button in empty state
  userId?: string | null;
  onGenerate?: () => void;
  /** Optional control for the panel header (e.g. a regenerate button). */
  action?: ReactNode;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function briefingAge(ts: number): string {
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days === 0) return 'Generated today';
  if (days === 1) return 'Generated yesterday';
  return `Generated ${days} days ago`;
}

export default function WeeklyPulse({ briefing, userId, onGenerate, action }: WeeklyPulseProps) {
  if (!briefing) {
    return (
      <Panel
        title="Weekly Pulse"
        right={
          <>
            {userId && onGenerate && (
              <GenerateBriefingButton type="user" userId={userId} onComplete={onGenerate} />
            )}
            {action}
          </>
        }
      >
        <Muted>
          {userId
            ? 'No briefing generated yet. Click the button to generate one now, or wait for the automatic Sunday run.'
            : 'Your first Weekly Pulse will appear here after the first Sunday briefing run. Check back on Monday.'
          }
        </Muted>
      </Panel>
    );
  }

  const paragraphs = briefing.body.split('\n\n').filter(p => p.trim());

  return (
    <Panel
      title="Weekly Pulse"
      badge={<Tag tone="judged">AI summary</Tag>}
      right={
        <>
          <span className="text-[13px] text-[#8F8F8F]" title={formatDate(briefing.generated_at)}>
            {briefingAge(briefing.generated_at)} · {formatDate(briefing.generated_at)}
          </span>
          {action}
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {paragraphs.map((p, i) => (
          <p key={i} className="m-0 text-[14px] text-[#333333] leading-6">
            {p}
          </p>
        ))}
        {briefing.suggestion && (
          <Notice tone="info" title="Suggestion for next week.">
            {briefing.suggestion}
          </Notice>
        )}
      </div>
    </Panel>
  );
}

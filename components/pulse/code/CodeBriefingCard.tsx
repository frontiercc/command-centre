// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Tag, Notice, Muted, B } from '@/components/precision/ui';

interface Briefing {
  body: string;
  suggestion: string | null;
  model: string;
  generated_at: number;
}

export default function CodeBriefingCard() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/pulse/code/briefing')
      .then(r => r.json())
      .then(d => setBriefing(d.briefing ?? null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/pulse/code/briefing', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Generation failed');
      setBriefing(d.briefing);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return null;

  return (
    <Panel
      title="This week in Code"
      badge={<Tag tone="judged">AI summary</Tag>}
      right={
        <>
          {briefing && (
            <span className="text-[13px] text-[#8F8F8F]">
              Generated {new Date(briefing.generated_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}
            </span>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className={briefing ? B.secondary : B.accent}
          >
            {generating ? 'Writing…' : briefing ? 'Regenerate' : 'Generate briefing'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="error">{error}</Notice>}
        {briefing ? (
          <>
            {briefing.body.split('\n\n').map((p, i) => (
              <p key={i} className="m-0 text-[14px] leading-[1.6] text-[#333333]">{p}</p>
            ))}
            {briefing.suggestion && (
              <Notice tone="info" title="Suggested action.">{briefing.suggestion}</Notice>
            )}
          </>
        ) : (
          <Muted>
            No briefing yet. It is generated automatically each week, or click Generate briefing. Written in plain
            language from the measured telemetry for people who never open this page.
          </Muted>
        )}
      </div>
    </Panel>
  );
}

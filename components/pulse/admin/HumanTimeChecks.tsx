// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';
/**
 * Monthly spot-check of the by-hand estimates, on the
 * admin Audit tab. Draw this month's 20 sessions per surface, read each one,
 * and mark the estimate about right, too high or too low (optionally with
 * your own figure). The Pulse cards show the latest month's result.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, Muted, Notice, Segmented, Chip, Tag, B, cx } from '@/components/precision/ui';

type Surface = 'cowork' | 'code';
type Verdict = 'about_right' | 'too_high' | 'too_low';
interface Item {
  id: number;
  sessionId: string;
  firstPrompt: string | null;
  prompts: number;
  toolCalls: number;
  claudeMinutes: number | null;
  estimate: { low: number | null; likely: number; high: number | null };
  verdict: Verdict | null;
  correctedMinutes: number | null;
}

const VERDICT_LABEL: Record<Verdict, string> = { about_right: 'About right', too_high: 'Too high', too_low: 'Too low' };

function hrs(min: number | null): string {
  if (min === null) return 'not measured';
  const h = min / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export default function HumanTimeChecks() {
  const [surface, setSurface] = useState<Surface>('cowork');
  const [items, setItems] = useState<Item[]>([]);
  const [period, setPeriod] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [corrected, setCorrected] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/pulse/admin/human-time-checks?surface=${surface}`);
      if (!r.ok) throw new Error("Couldn't load this page. Try again.");
      const d = await r.json();
      setItems(d.items);
      setPeriod(d.period);
    } catch {
      setError('Could not load the spot-check.');
    } finally {
      setLoading(false);
    }
  }, [surface]);

  useEffect(() => { void load(); }, [load]);

  async function post(body: object) {
    const r = await fetch('/api/pulse/admin/human-time-checks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? 'Could not save.');
      return false;
    }
    return true;
  }

  async function review(item: Item, verdict: Verdict) {
    const raw = corrected[item.id]?.trim();
    const minutes = raw ? Math.round(Number(raw) * 60) : null;
    if (raw && (!Number.isFinite(minutes) || (minutes ?? 0) < 1)) { setError('Your figure must be a number of hours.'); return; }
    if (await post({ action: 'review', id: item.id, verdict, correctedMinutes: minutes })) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, verdict, correctedMinutes: minutes } : i));
    }
  }

  const reviewed = items.filter(i => i.verdict).length;
  const aboutRight = items.filter(i => i.verdict === 'about_right').length;

  return (
    <Panel
      title="Human time estimates: spot-check"
      badge={<Tag tone="judged">Estimate</Tag>}
      right={
        <Segmented<Surface>
          label="Surface"
          value={surface}
          onChange={setSurface}
          options={[{ value: 'cowork', label: 'Cowork' }, { value: 'code', label: 'Code' }]}
        />
      }
      flush
    >
      <p className="m-0 px-4 py-3 text-[13px] text-[#666666] leading-5">
        Each month, read 20 estimated sessions and say whether the by-hand estimate looks right. Optionally add your own figure in hours.
        The Pulse cards show how many were judged about right.
      </p>

      {error && <div className="px-4 pb-3"><Notice tone="error">{error}</Notice></div>}
      {loading ? (
        <div className="px-4 pb-4"><Muted>Loading…</Muted></div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 flex-wrap px-4 pb-4">
          <Muted>No sample drawn for {period} yet.</Muted>
          <button type="button" onClick={async () => { if (await post({ action: 'draw', surface })) void load(); }}
            className={B.primary}>Draw this month&apos;s sample</button>
        </div>
      ) : (
        <>
          <p className="m-0 px-4 pb-3 text-[13px] text-[#666666] tabular-nums">{period}: {reviewed} of {items.length} reviewed, {aboutRight} judged about right.</p>
          <div>
            {items.map(i => (
              <div key={i.id} className="px-4 py-3 border-t border-[#F2F2F2]">
                <p className="m-0 text-[14px] text-[#0A0A0A] whitespace-pre-wrap break-words">{i.firstPrompt ?? <span className="text-[#8F8F8F]">No readable prompt (removed by retention)</span>}</p>
                <p className="m-0 mt-1.5 text-[13px] text-[#8F8F8F] tabular-nums">
                  {i.prompts} prompts · {i.toolCalls} tool calls · <span className="text-[#05073F] font-medium">{hrs(i.claudeMinutes)} with Claude</span> ·{' '}
                  <span className="text-[#2451F3]">estimate {hrs(i.estimate.likely)} by hand{i.estimate.low !== null && i.estimate.high !== null ? ` (${hrs(i.estimate.low)}–${hrs(i.estimate.high)})` : ''}</span>
                </p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {(Object.keys(VERDICT_LABEL) as Verdict[]).map(v => (
                    <Chip key={v} on={i.verdict === v} onClick={() => review(i, v)}>
                      {VERDICT_LABEL[v]}
                    </Chip>
                  ))}
                  <input
                    type="number" min="0" step="0.5" placeholder="Your figure (hours)"
                    aria-label="Your figure (hours)"
                    value={corrected[i.id] ?? (i.correctedMinutes !== null ? String(i.correctedMinutes / 60) : '')}
                    onChange={e => setCorrected(prev => ({ ...prev, [i.id]: e.target.value }))}
                    className={cx(B.input, 'w-40 text-[13px] py-1')}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
